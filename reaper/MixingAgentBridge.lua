-- REAPER Mixing Agent bridge (protocol 1).
--
-- This first bridge intentionally accepts only the generated command envelope emitted by
-- the TypeScript runtime. A small strict JSON decoder is included here instead of using
-- greedy patterns: malformed JSON, duplicate keys, unescaped controls, unknown envelope
-- fields, and invalid identifiers are rejected. Mutations are limited to validated mix-plan
-- transactions and renders inside the configured artifact root.

local SECTION = "reaper_mixing_agent"
local runtime_root = reaper.GetExtState("reaper_mixing_agent", "runtime_root")
local artifact_root = reaper.GetExtState("reaper_mixing_agent", "artifact_root")
local bridge_instance_id = reaper.GetExtState("reaper_mixing_agent", "bridge_instance_id")

if runtime_root == "" or artifact_root == "" or bridge_instance_id == "" then
  reaper.ShowConsoleMsg(
    "REAPER Mixing Agent bridge stopped: set ExtState "
      .. SECTION
      .. "/runtime_root and "
      .. SECTION
      .. "/artifact_root and bridge_instance_id first.\n"
  )
  return
end

local bridge_root = runtime_root .. "/bridge/" .. bridge_instance_id
local paths = {
  heartbeat = bridge_root .. "/heartbeat.json",
  command_tmp = bridge_root .. "/commands/tmp",
  command_ready = bridge_root .. "/commands/ready",
  command_claimed = bridge_root .. "/commands/claimed",
  command_finished = bridge_root .. "/commands/finished",
  receipt_tmp = bridge_root .. "/receipts/tmp",
  receipt_ready = bridge_root .. "/receipts/ready",
}

for _, path in pairs(paths) do
  if path ~= paths.heartbeat then reaper.RecursiveCreateDirectory(path, 0) end
end

local JSON_NULL = {}

local function decode_json(source)
  local position = 1
  local length = #source

  local function fail(message)
    error("JSON at byte " .. position .. ": " .. message, 0)
  end

  local function skip_space()
    while position <= length and source:sub(position, position):match("[ \t\r\n]") do
      position = position + 1
    end
  end

  local function unicode_utf8(codepoint)
    if codepoint <= 0x7F then return string.char(codepoint) end
    if codepoint <= 0x7FF then
      return string.char(0xC0 | (codepoint >> 6), 0x80 | (codepoint & 0x3F))
    end
    if codepoint <= 0xFFFF then
      return string.char(
        0xE0 | (codepoint >> 12),
        0x80 | ((codepoint >> 6) & 0x3F),
        0x80 | (codepoint & 0x3F)
      )
    end
    return string.char(
      0xF0 | (codepoint >> 18),
      0x80 | ((codepoint >> 12) & 0x3F),
      0x80 | ((codepoint >> 6) & 0x3F),
      0x80 | (codepoint & 0x3F)
    )
  end

  local function parse_hex4()
    local digits = source:sub(position, position + 3)
    if #digits ~= 4 or not digits:match("^[0-9a-fA-F]+$") then fail("invalid unicode escape") end
    position = position + 4
    return tonumber(digits, 16)
  end

  local function parse_string()
    if source:sub(position, position) ~= '"' then fail("expected string") end
    position = position + 1
    local output = {}
    while position <= length do
      local byte = source:byte(position)
      local character = source:sub(position, position)
      if character == '"' then
        position = position + 1
        return table.concat(output)
      end
      if byte < 0x20 then fail("unescaped control character") end
      if character ~= "\\" then
        output[#output + 1] = character
        position = position + 1
      else
        position = position + 1
        local escaped = source:sub(position, position)
        local replacements = {
          ['"'] = '"',
          ["\\"] = "\\",
          ["/"] = "/",
          b = "\b",
          f = "\f",
          n = "\n",
          r = "\r",
          t = "\t",
        }
        if replacements[escaped] then
          output[#output + 1] = replacements[escaped]
          position = position + 1
        elseif escaped == "u" then
          position = position + 1
          local codepoint = parse_hex4()
          if codepoint >= 0xD800 and codepoint <= 0xDBFF then
            if source:sub(position, position + 1) ~= "\\u" then fail("missing low surrogate") end
            position = position + 2
            local low = parse_hex4()
            if low < 0xDC00 or low > 0xDFFF then fail("invalid low surrogate") end
            codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00)
          elseif codepoint >= 0xDC00 and codepoint <= 0xDFFF then
            fail("unexpected low surrogate")
          end
          output[#output + 1] = unicode_utf8(codepoint)
        else
          fail("invalid escape")
        end
      end
    end
    fail("unterminated string")
  end

  local parse_value

  local function parse_number()
    local start = position
    if source:sub(position, position) == "-" then position = position + 1 end
    if source:sub(position, position) == "0" then
      position = position + 1
      if source:sub(position, position):match("%d") then fail("leading zero") end
    else
      if not source:sub(position, position):match("[1-9]") then fail("invalid number") end
      repeat position = position + 1 until not source:sub(position, position):match("%d")
    end
    if source:sub(position, position) == "." then
      position = position + 1
      if not source:sub(position, position):match("%d") then fail("invalid fraction") end
      repeat position = position + 1 until not source:sub(position, position):match("%d")
    end
    if source:sub(position, position):match("[eE]") then
      position = position + 1
      if source:sub(position, position):match("[+-]") then position = position + 1 end
      if not source:sub(position, position):match("%d") then fail("invalid exponent") end
      repeat position = position + 1 until not source:sub(position, position):match("%d")
    end
    local value = tonumber(source:sub(start, position - 1))
    if not value then fail("invalid number") end
    return value
  end

  local function parse_array()
    position = position + 1
    local output = { __json_array = true }
    skip_space()
    if source:sub(position, position) == "]" then
      position = position + 1
      return output
    end
    while true do
      output[#output + 1] = parse_value()
      skip_space()
      local delimiter = source:sub(position, position)
      if delimiter == "]" then
        position = position + 1
        return output
      end
      if delimiter ~= "," then fail("expected comma or closing bracket") end
      position = position + 1
      skip_space()
    end
  end

  local function parse_object()
    position = position + 1
    local output = {}
    skip_space()
    if source:sub(position, position) == "}" then
      position = position + 1
      return output
    end
    while true do
      local key = parse_string()
      if output[key] ~= nil then fail("duplicate object key") end
      skip_space()
      if source:sub(position, position) ~= ":" then fail("expected colon") end
      position = position + 1
      output[key] = parse_value()
      skip_space()
      local delimiter = source:sub(position, position)
      if delimiter == "}" then
        position = position + 1
        return output
      end
      if delimiter ~= "," then fail("expected comma or closing brace") end
      position = position + 1
      skip_space()
    end
  end

  parse_value = function()
    skip_space()
    local character = source:sub(position, position)
    if character == '"' then return parse_string() end
    if character == "{" then return parse_object() end
    if character == "[" then return parse_array() end
    if character == "-" or character:match("%d") then return parse_number() end
    if source:sub(position, position + 3) == "true" then
      position = position + 4
      return true
    end
    if source:sub(position, position + 4) == "false" then
      position = position + 5
      return false
    end
    if source:sub(position, position + 3) == "null" then
      position = position + 4
      return JSON_NULL
    end
    fail("unexpected token")
  end

  local result = parse_value()
  skip_space()
  if position <= length then fail("trailing data") end
  return result
end

local function encode_string(value)
  local replacements = {
    ['"'] = '\\"',
    ["\\"] = "\\\\",
    ["\b"] = "\\b",
    ["\f"] = "\\f",
    ["\n"] = "\\n",
    ["\r"] = "\\r",
    ["\t"] = "\\t",
  }
  return '"'
    .. value:gsub('[%z\1-\31\\"]', function(character)
      return replacements[character] or string.format("\\u%04x", character:byte())
    end)
    .. '"'
end

local function encode_json(value)
  if value == JSON_NULL or value == nil then return "null" end
  if type(value) == "boolean" then return value and "true" or "false" end
  if type(value) == "number" then return string.format("%.17g", value) end
  if type(value) == "string" then return encode_string(value) end
  if type(value) ~= "table" then error("cannot encode JSON type " .. type(value)) end
  if value.__json_array then
    local parts = {}
    for index = 1, #value do parts[index] = encode_json(value[index]) end
    return "[" .. table.concat(parts, ",") .. "]"
  end
  local keys = {}
  for key in pairs(value) do
    if key ~= "__json_array" then keys[#keys + 1] = key end
  end
  table.sort(keys)
  local parts = {}
  for index, key in ipairs(keys) do
    parts[index] = encode_string(key) .. ":" .. encode_json(value[key])
  end
  return "{" .. table.concat(parts, ",") .. "}"
end

local function read_file(path)
  local file, message = io.open(path, "rb")
  if not file then return nil, message end
  local contents = file:read("*a")
  file:close()
  return contents
end

local function atomic_write(path, temporary_directory, value)
  local name = path:match("([^/\\]+)$")
  local temporary = temporary_directory .. "/." .. name .. ".tmp"
  local file, message = io.open(temporary, "wb")
  if not file then return nil, message end
  file:write(encode_json(value), "\n")
  file:flush()
  file:close()
  local renamed, rename_message = os.rename(temporary, path)
  if not renamed then
    os.remove(path)
    renamed, rename_message = os.rename(temporary, path)
  end
  return renamed, rename_message
end

local function now_iso()
  return os.date("!%Y-%m-%dT%H:%M:%SZ")
end

local function parse_utc_timestamp(value)
  if type(value) ~= "string" then return nil end
  local year, month, day, hour, minute, second, fraction = value:match(
    "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)(%.%d+)Z$"
  )
  if not year then
    year, month, day, hour, minute, second = value:match(
      "^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)Z$"
    )
  end
  if not year then return nil end
  local numeric_year = tonumber(year)
  local numeric_month = tonumber(month)
  local numeric_day = tonumber(day)
  local numeric_hour = tonumber(hour)
  local numeric_minute = tonumber(minute)
  local numeric_second = tonumber(second)
  local leap_year = numeric_year % 4 == 0 and (numeric_year % 100 ~= 0 or numeric_year % 400 == 0)
  local month_days = { 31, leap_year and 29 or 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
  if numeric_month < 1 or numeric_month > 12
    or numeric_day < 1 or numeric_day > (month_days[numeric_month] or 0)
    or numeric_hour > 23
    or numeric_minute > 59
    or numeric_second > 59
  then
    return nil
  end
  -- UTC calendar fields in fixed-width order compare chronologically. The value
  -- remains below Lua's exact-integer limit; keep the optional fraction too.
  return tonumber(year .. month .. day .. hour .. minute .. second) + tonumber(fraction or "0")
end

local function deadline_expired(deadline_at)
  local deadline = parse_utc_timestamp(deadline_at)
  if not deadline then return nil, "invalid deadline timestamp" end
  return parse_utc_timestamp(now_iso()) > deadline
end

local function project_snapshot()
  local project, project_path = reaper.EnumProjects(-1, "")
  local tracks = { __json_array = true }
  local total_tracks = reaper.CountTracks(project)
  for index = 0, total_tracks - 1 do
    local track = reaper.GetTrack(project, index)
    local _, track_name = reaper.GetTrackName(track, "")
    local effects = { __json_array = true }
    local sends = { __json_array = true }
    local offline_count = 0
    for fx_index = 0, reaper.TrackFX_GetCount(track) - 1 do
      local _, fx_name = reaper.TrackFX_GetFXName(track, fx_index, "")
      local offline = false
      if reaper.TrackFX_GetOffline then offline = reaper.TrackFX_GetOffline(track, fx_index) end
      if offline then offline_count = offline_count + 1 end
      effects[#effects + 1] = {
        guid = reaper.TrackFX_GetFXGUID(track, fx_index),
        name = fx_name,
        enabled = reaper.TrackFX_GetEnabled(track, fx_index),
        offline = offline,
      }
    end
    for send_index = 0, reaper.GetTrackNumSends(track, 0) - 1 do
      local destination = reaper.GetTrackSendInfo_Value(track, 0, send_index, "P_DESTTRACK")
      if destination then
        local _, destination_name = reaper.GetTrackName(destination, "")
        sends[#sends + 1] = {
          destination_guid = reaper.GetTrackGUID(destination),
          destination_name = destination_name,
          volume = reaper.GetTrackSendInfo_Value(track, 0, send_index, "D_VOL"),
        }
      end
    end
    tracks[#tracks + 1] = {
      guid = reaper.GetTrackGUID(track),
      name = track_name,
      index = index,
      mute = reaper.GetMediaTrackInfo_Value(track, "B_MUTE") ~= 0,
      solo = reaper.GetMediaTrackInfo_Value(track, "I_SOLO"),
      volume = reaper.GetMediaTrackInfo_Value(track, "D_VOL"),
      pan = reaper.GetMediaTrackInfo_Value(track, "D_PAN"),
      media_item_count = reaper.CountTrackMediaItems(track),
      main_send = reaper.GetMediaTrackInfo_Value(track, "B_MAINSEND") ~= 0,
      fx_offline_count = offline_count,
      fx = effects,
      sends = sends,
    }
  end
  local project_name = project_path:match("([^/\\]+)$") or "Untitled"
  return {
    project_id = project_path ~= "" and project_path or ("unsaved:" .. bridge_instance_id),
    project_path = project_path,
    project_name = project_name,
    project_change_count = reaper.GetProjectStateChangeCount(project),
    track_count = total_tracks,
    tracks = tracks,
  }
end

local function db_to_amplitude(db)
  return 10 ^ (db / 20)
end

local function amplitude_to_db(amplitude)
  if amplitude <= 0 then return -150 end
  return 20 * math.log(amplitude) / math.log(10)
end

local function clamp(value, minimum, maximum)
  return math.max(minimum, math.min(maximum, value))
end

local function parse_hex_color(value)
  if type(value) ~= "string" or not value:match("^#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]$") then
    return nil
  end
  local red = tonumber(value:sub(2, 3), 16)
  local green = tonumber(value:sub(4, 5), 16)
  local blue = tonumber(value:sub(6, 7), 16)
  return reaper.ColorToNative(red, green, blue) | 0x1000000
end

local function validate_blueprint(payload)
  if type(payload.id) ~= "string" or payload.id == "" then return nil, "blueprint id is required" end
  if type(payload.sampleRate) ~= "number" or payload.sampleRate < 8000 or payload.sampleRate > 384000 then
    return nil, "invalid project sample rate"
  end
  if type(payload.tracks) ~= "table" or not payload.tracks.__json_array or #payload.tracks == 0 then
    return nil, "blueprint tracks must be a non-empty array"
  end
  if type(payload.sends) ~= "table" or not payload.sends.__json_array then
    return nil, "blueprint sends must be an array"
  end
  local names = {}
  for _, track in ipairs(payload.tracks) do
    if type(track) ~= "table" or type(track.name) ~= "string" or track.name == "" or names[track.name] then
      return nil, "track names must be non-empty and unique"
    end
    names[track.name] = true
    if type(track.effects) ~= "table" or not track.effects.__json_array then
      return nil, "track effects must be an array"
    end
    for _, effect in ipairs(track.effects) do
      if type(effect) ~= "table" or type(effect.plugin) ~= "string" or effect.plugin == "" then
        return nil, "effect plugin name is required"
      end
      if effect.normalizedParameters ~= nil and type(effect.normalizedParameters) ~= "table" then
        return nil, "normalized effect parameters must be an object"
      end
    end
  end
  for _, send in ipairs(payload.sends) do
    if type(send) ~= "table" or not names[send.from] or not names[send.to] or type(send.gainDb) ~= "number" then
      return nil, "send references an unknown track or invalid gain"
    end
  end
  return true
end

local function bootstrap_project(payload)
  local project = reaper.EnumProjects(-1, "")
  if reaper.CountTracks(project) ~= 0 then error("project must be empty") end
  local valid, message = validate_blueprint(payload)
  if not valid then error(message) end

  local tracks_by_name = {}
  reaper.PreventUIRefresh(1)
  reaper.Undo_BeginBlock2(project)
  local ok, result = xpcall(function()
    reaper.GetSetProjectInfo(project, "PROJECT_SRATE", payload.sampleRate, true)
    for index, definition in ipairs(payload.tracks) do
      reaper.InsertTrackAtIndex(index - 1, true)
      local track = reaper.GetTrack(project, index - 1)
      reaper.GetSetMediaTrackInfo_String(track, "P_NAME", definition.name, true)
      reaper.SetMediaTrackInfo_Value(track, "B_MAINSEND", definition.name == "MIX BUS" and 1 or 0)
      local color = parse_hex_color(definition.color)
      if color then reaper.SetMediaTrackInfo_Value(track, "I_CUSTOMCOLOR", color) end
      tracks_by_name[definition.name] = track
      for _, effect in ipairs(definition.effects) do
        local fx_index = reaper.TrackFX_AddByName(track, effect.plugin, false, -1)
        if fx_index < 0 then error("unable to load effect " .. effect.plugin .. " on " .. definition.name) end
        if effect.wetOnly == true then
          local wet_parameter = reaper.TrackFX_GetParamFromIdent(track, fx_index, ":wet")
          if wet_parameter < 0 or not reaper.TrackFX_SetParamNormalized(track, fx_index, wet_parameter, 1) then
            error("unable to set effect 100% wet: " .. effect.plugin)
          end
        end
        if effect.normalizedParameters then
          for parameter, value in pairs(effect.normalizedParameters) do
            local parameter_index = tonumber(parameter)
            if not parameter_index or type(value) ~= "number" or value < 0 or value > 1 then
              error("invalid normalized parameter for " .. effect.plugin)
            end
            reaper.TrackFX_SetParamNormalized(track, fx_index, parameter_index, value)
          end
        end
      end
    end
    for _, definition in ipairs(payload.sends) do
      local source = tracks_by_name[definition.from]
      local destination = tracks_by_name[definition.to]
      local send_index = reaper.CreateTrackSend(source, destination)
      if send_index < 0 then error("unable to create send " .. definition.from .. " -> " .. definition.to) end
      reaper.SetTrackSendInfo_Value(source, 0, send_index, "D_VOL", db_to_amplitude(definition.gainDb))
    end
    reaper.TrackList_AdjustWindows(false)
    reaper.UpdateArrange()
    return project_snapshot()
  end, debug.traceback)
  reaper.Undo_EndBlock2(project, "REAPER Mixing Agent: bootstrap vocal mix", -1)
  reaper.PreventUIRefresh(-1)
  if not ok then
    reaper.Undo_DoUndo2(project)
    error(result)
  end
  return result
end

local function find_track_by_name(project, name)
  local found = nil
  for index = 0, reaper.CountTracks(project) - 1 do
    local track = reaper.GetTrack(project, index)
    local _, track_name = reaper.GetTrackName(track, "")
    if track_name == name then
      if found then error("track name is ambiguous: " .. name) end
      found = track
    end
  end
  if not found then error("track not found: " .. tostring(name)) end
  return found
end

local function valid_track_identity(identity)
  return type(identity) == "table"
    and type(identity.guid) == "string" and identity.guid ~= ""
    and type(identity.name) == "string" and identity.name ~= ""
end

local function find_track_by_identity(project, identity)
  if not valid_track_identity(identity) then error("track identity requires guid and name") end
  local found = nil
  for index = 0, reaper.CountTracks(project) - 1 do
    local track = reaper.GetTrack(project, index)
    if reaper.GetTrackGUID(track) == identity.guid then
      if found then error("track GUID is ambiguous: " .. identity.guid) end
      found = track
    end
  end
  if not found then error("track GUID not found: " .. identity.guid) end
  local _, actual_name = reaper.GetTrackName(found, "")
  if actual_name ~= identity.name then error("track identity changed: " .. identity.guid) end
  return found
end

local function find_send(source, destination)
  local found = nil
  for index = 0, reaper.GetTrackNumSends(source, 0) - 1 do
    if reaper.GetTrackSendInfo_Value(source, 0, index, "P_DESTTRACK") == destination then
      if found then error("send is ambiguous") end
      found = index
    end
  end
  if found == nil then error("send not found") end
  return found
end

local fabfilter_probe_plugins = {
  ["Pro-Q 4 (FabFilter)"] = true,
  ["Pro-C 2 (FabFilter)"] = true,
  ["Pro-DS (FabFilter)"] = true,
  ["Pro-L 2 (FabFilter)"] = true,
}

local mix_action_plugins = {
  ["ReaEQ (Cockos)"] = true,
  ["ReaComp (Cockos)"] = true,
  ["ReaXcomp (Cockos)"] = true,
  ["ReaLimit (Cockos)"] = true,
  ["Pro-Q 4 (FabFilter)"] = true,
  ["Pro-C 2 (FabFilter)"] = true,
  ["Pro-DS (FabFilter)"] = true,
  ["Pro-L 2 (FabFilter)"] = true,
}

local function enumerate_fx_parameters(track, fx_index)
  local parameter_count = reaper.TrackFX_GetNumParams(track, fx_index)
  if parameter_count < 0 or parameter_count > 4096 then error("invalid FX parameter count") end
  local parameters = { __json_array = true }
  for parameter_index = 0, parameter_count - 1 do
    local _, parameter_name = reaper.TrackFX_GetParamName(track, fx_index, parameter_index, "")
    local _, parameter_ident = reaper.TrackFX_GetParamIdent(track, fx_index, parameter_index, "")
    local normalized_value = reaper.TrackFX_GetParamNormalized(track, fx_index, parameter_index)
    local _, formatted_value = reaper.TrackFX_GetFormattedParamValue(track, fx_index, parameter_index, "")
    parameters[#parameters + 1] = {
      index = parameter_index,
      name = parameter_name or "",
      ident = parameter_ident or "",
      normalizedValue = normalized_value,
      formattedValue = formatted_value or "",
    }
  end
  return parameters
end

local function fx_is_active(track, fx_index)
  if not reaper.TrackFX_GetEnabled(track, fx_index) then return false end
  if reaper.TrackFX_GetOffline and reaper.TrackFX_GetOffline(track, fx_index) then return false end
  return true
end

local function probe_fx(payload)
  for key in pairs(payload) do
    if key ~= "plugin" and key ~= "format" and key ~= "track" and key ~= "fxGuid" then
      error("unknown FX probe field: " .. tostring(key))
    end
  end
  if type(payload.plugin) ~= "string" or not fabfilter_probe_plugins[payload.plugin] then
    error("FX probe plugin is not allowlisted")
  end
  if payload.format ~= "VST3" and payload.format ~= "CLAP" then
    error("FX probe format must be VST3 or CLAP")
  end
  local formatted_plugin_name = payload.format .. ": " .. payload.plugin
  local project = reaper.EnumProjects(-1, "")
  local targeted = payload.track ~= nil or payload.fxGuid ~= nil
  if targeted then
    if not valid_track_identity(payload.track)
      or type(payload.fxGuid) ~= "string" or payload.fxGuid == ""
    then
      error("targeted FX probe requires track identity and fxGuid")
    end
    local target_track = find_track_by_identity(project, payload.track)
    local target_fx = nil
    for index = 0, reaper.TrackFX_GetCount(target_track) - 1 do
      if reaper.TrackFX_GetFXGUID(target_track, index) == payload.fxGuid then
        if target_fx ~= nil then error("FX GUID is ambiguous") end
        target_fx = index
      end
    end
    if target_fx == nil then error("probed FX GUID no longer exists") end
    local _, actual_name = reaper.TrackFX_GetFXName(target_track, target_fx, "")
    if actual_name ~= formatted_plugin_name then error("probed FX identity changed") end
    if not fx_is_active(target_track, target_fx) then error("probed FabFilter instance is disabled or offline") end
    return {
      plugin = payload.plugin,
      format = payload.format,
      parameters = enumerate_fx_parameters(target_track, target_fx),
    }
  end

  local track = nil
  local inserted_track_index = nil
  reaper.PreventUIRefresh(1)
  reaper.Undo_BeginBlock2(project)
  local ok, result = xpcall(function()
    local track_index = reaper.CountTracks(project)
    inserted_track_index = track_index
    reaper.InsertTrackAtIndex(track_index, true)
    track = reaper.GetTrack(project, track_index)
    if not track then error("unable to create disposable FX probe track") end
    reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "__RMA_FABFILTER_PROBE__", true)
    local fx_index = reaper.TrackFX_AddByName(track, formatted_plugin_name, false, -1)
    if fx_index < 0 then error("unable to load probed FX: " .. payload.plugin) end
    return {
      plugin = payload.plugin,
      format = payload.format,
      parameters = enumerate_fx_parameters(track, fx_index),
    }
  end, debug.traceback)
  local cleanup_track = track
  if not cleanup_track and inserted_track_index ~= nil then
    cleanup_track = reaper.GetTrack(project, inserted_track_index)
  end
  if cleanup_track then reaper.DeleteTrack(cleanup_track) end
  reaper.Undo_EndBlock2(project, "REAPER Mixing Agent: transient FabFilter probe", -1)
  -- Restore the exact state before the disposable probe even if cleanup could
  -- not recover the inserted track handle. Targeted probes never enter Undo.
  -- SAFETY: only undo when the top undo entry is our own probe block. If the
  -- block did not land (e.g. REAPER merged/dropped the net-zero change), the
  -- explicit DeleteTrack above already cleaned up, and undoing here would eat
  -- an unrelated user/engine undo block (observed: probe silenced live mixes).
  local probe_undo_label = reaper.Undo_CanUndo2(project)
  if probe_undo_label == "REAPER Mixing Agent: transient FabFilter probe" then
    reaper.Undo_DoUndo2(project)
  end
  reaper.PreventUIRefresh(-1)
  if not ok then error(result) end
  return result
end

local function validate_mix_plan(payload)
  if payload.schema ~= "rma.mix-plan/v2" then return nil, "unsupported mix plan schema" end
  if type(payload.sourceEventId) ~= "string" or payload.sourceEventId == "" then
    return nil, "mix plan sourceEventId is required"
  end
  if type(payload.sourceText) ~= "string" or type(payload.summary) ~= "string" then
    return nil, "mix plan text and summary are required"
  end
  if type(payload.actions) ~= "table" or not payload.actions.__json_array
    or #payload.actions < 1 or #payload.actions > 12
  then
    return nil, "mix plan must contain 1 to 12 actions"
  end
  for _, action in ipairs(payload.actions) do
    if type(action) ~= "table" or type(action.reason) ~= "string" or action.reason == "" then
      return nil, "mix action reason is required"
    end
    if action.type == "track.gain.delta" then
      if not valid_track_identity(action.track) or type(action.deltaDb) ~= "number"
        or action.deltaDb < -6 or action.deltaDb > 6
      then
        return nil, "invalid track gain action"
      end
    elseif action.type == "send.gain.delta" then
      if not valid_track_identity(action.from) or not valid_track_identity(action.to)
        or type(action.deltaDb) ~= "number"
        or action.deltaDb < -6 or action.deltaDb > 6
      then
        return nil, "invalid send gain action"
      end
    elseif action.type == "fx.parameter.delta" then
      if not valid_track_identity(action.track) or type(action.fx) ~= "string" or type(action.parameter) ~= "string"
        or type(action.deltaNormalized) ~= "number"
        or action.deltaNormalized < -0.2 or action.deltaNormalized > 0.2
      then
        return nil, "invalid FX parameter action"
      end
      if not mix_action_plugins[action.fx] then return nil, "FX is not allowlisted for mix actions" end
      local is_fabfilter = fabfilter_probe_plugins[action.fx] == true
      if is_fabfilter then
        if (action.fxFormat ~= "VST3" and action.fxFormat ~= "CLAP")
          or type(action.fxGuid) ~= "string" or action.fxGuid == ""
          or type(action.parameterIdent) ~= "string" or action.parameterIdent == ""
        then
          return nil, "FabFilter mix action requires proven fxFormat, fxGuid, and parameterIdent"
        end
      elseif action.fxFormat ~= nil or action.fxGuid ~= nil or action.parameterIdent ~= nil then
        return nil, "stock FX action must not carry FabFilter proof fields"
      end
    else
      return nil, "unknown mix action"
    end
  end
  return true
end

local function execute_transaction(payload)
  local valid, validation_error = validate_mix_plan(payload)
  if not valid then error(validation_error) end
  local project = reaper.EnumProjects(-1, "")
  local adjustments = { __json_array = true }
  reaper.PreventUIRefresh(1)
  reaper.Undo_BeginBlock2(project)
  local ok, result = xpcall(function()
    for action_index, action in ipairs(payload.actions) do
      if action.type == "track.gain.delta" then
        local track = find_track_by_identity(project, action.track)
        local before = amplitude_to_db(reaper.GetMediaTrackInfo_Value(track, "D_VOL"))
        local after = clamp(before + action.deltaDb, -150, 12)
        reaper.SetMediaTrackInfo_Value(track, "D_VOL", db_to_amplitude(after))
        adjustments[#adjustments + 1] = {
          actionIndex = action_index - 1,
          track = action.track.name,
          plugin = "REAPER track control",
          parameter = "volumeDb",
          before = before,
          after = after,
          beforeFormatted = string.format("%.2f dB", before),
          afterFormatted = string.format("%.2f dB", after),
          reason = action.reason,
        }
      elseif action.type == "send.gain.delta" then
        local source = find_track_by_identity(project, action.from)
        local destination = find_track_by_identity(project, action.to)
        local send_index = find_send(source, destination)
        local before = amplitude_to_db(reaper.GetTrackSendInfo_Value(source, 0, send_index, "D_VOL"))
        local after = clamp(before + action.deltaDb, -150, 12)
        reaper.SetTrackSendInfo_Value(source, 0, send_index, "D_VOL", db_to_amplitude(after))
        adjustments[#adjustments + 1] = {
          actionIndex = action_index - 1,
          track = action.from.name,
          plugin = "REAPER routing",
          parameter = "sendDb:" .. action.to.name,
          before = before,
          after = after,
          beforeFormatted = string.format("%.2f dB", before),
          afterFormatted = string.format("%.2f dB", after),
          reason = action.reason,
        }
      else
        local track = find_track_by_identity(project, action.track)
        local is_fabfilter = fabfilter_probe_plugins[action.fx] == true
        local fx_index = nil
        if is_fabfilter then
          for index = 0, reaper.TrackFX_GetCount(track) - 1 do
            if reaper.TrackFX_GetFXGUID(track, index) == action.fxGuid then
              if fx_index ~= nil then error("proven FabFilter FX GUID is ambiguous") end
              fx_index = index
            end
          end
          if fx_index == nil then error("proven FabFilter FX no longer exists") end
          local _, actual_name = reaper.TrackFX_GetFXName(track, fx_index, "")
          if actual_name ~= action.fxFormat .. ": " .. action.fx then
            error("proven FabFilter FX identity changed")
          end
          if not fx_is_active(track, fx_index) then
            error("proven FabFilter instance is disabled or offline")
          end
        else
          fx_index = reaper.TrackFX_AddByName(track, action.fx, false, 0)
          if fx_index < 0 then error("FX not found: " .. action.fx .. " on " .. action.track.name) end
        end
        local parameter_index = nil
        local available_parameter_names = { __json_array = true }
        if is_fabfilter then
          parameter_index = reaper.TrackFX_GetParamFromIdent(track, fx_index, action.parameterIdent)
          if parameter_index == nil or parameter_index < 0 then
            error("proven FabFilter parameter no longer exists: " .. action.parameterIdent)
          end
        elseif action.parameter == "semantic:wet" then
          parameter_index = reaper.TrackFX_GetParamFromIdent(track, fx_index, ":wet")
        else
          local threshold_matches = { __json_array = true }
          local preferred_high_threshold = nil
          for index = 0, reaper.TrackFX_GetNumParams(track, fx_index) - 1 do
            local _, parameter_name = reaper.TrackFX_GetParamName(track, fx_index, index, "")
            available_parameter_names[#available_parameter_names + 1] = parameter_name
            local normalized_name = parameter_name:lower():gsub("[%s_%-]", "")
            local matches_air = action.parameter == "semantic:airGain"
              and (
                normalized_name == "4gain"
                or normalized_name == "band4gain"
                or normalized_name:match("^gainhighshelf%d*$")
                or normalized_name:match("^highshelf%d*gain$")
              )
            local matches_threshold = normalized_name:find("thresh", 1, true) ~= nil
            if matches_threshold then
              threshold_matches[#threshold_matches + 1] = index
              if normalized_name:match("^4.*thresh") or normalized_name:match("^band4.*thresh") then
                preferred_high_threshold = index
              end
            end
            if parameter_name:lower() == action.parameter:lower() or matches_air then
              if parameter_index then error("FX parameter is ambiguous: " .. action.parameter) end
              parameter_index = index
            end
          end
          if action.parameter == "semantic:compressorThreshold" then
            if #threshold_matches ~= 1 then error("FX compressor threshold is missing or ambiguous") end
            parameter_index = threshold_matches[1]
          elseif action.parameter == "semantic:deesserThreshold" then
            parameter_index = preferred_high_threshold or threshold_matches[#threshold_matches]
          end
        end
        if parameter_index == nil or parameter_index < 0 then
          error("FX parameter not found: " .. action.parameter
            .. " on " .. action.fx .. " (available: " .. table.concat(available_parameter_names, " | ") .. ")")
        end
        local before = reaper.TrackFX_GetParamNormalized(track, fx_index, parameter_index)
        local _, before_fmt = reaper.TrackFX_GetFormattedParamValue(track, fx_index, parameter_index, "")
        local after = clamp(before + action.deltaNormalized, 0, 1)
        if math.abs(after - before) < 0.000000001 then
          error("FX parameter adjustment reached its limit without changing value: " .. action.parameter)
        end
        if not reaper.TrackFX_SetParamNormalized(track, fx_index, parameter_index, after) then
          error("unable to set FX parameter: " .. action.parameter)
        end
        local _, after_fmt = reaper.TrackFX_GetFormattedParamValue(track, fx_index, parameter_index, "")
        local _, param_name = reaper.TrackFX_GetParamName(track, fx_index, parameter_index, "")
        -- Band 类参数（Pro-Q 等）：band 序号随增删/重排漂移，记录当时的位置与形状
        local param_context = nil
        local band_no = param_name and param_name:match("Band (%d+)")
        if band_no then
          local shape, freq
          for p2 = 0, reaper.TrackFX_GetNumParams(track, fx_index) - 1 do
            local _, pn2 = reaper.TrackFX_GetParamName(track, fx_index, p2, "")
            if pn2 == "Band " .. band_no .. " Shape" then
              local _, f = reaper.TrackFX_GetFormattedParamValue(track, fx_index, p2, "")
              shape = f
            elseif pn2 == "Band " .. band_no .. " Frequency" then
              local _, f = reaper.TrackFX_GetFormattedParamValue(track, fx_index, p2, "")
              freq = f
            end
          end
          if shape or freq then
            param_context = tostring(shape or "?") .. " @ " .. tostring(freq or "?")
          end
        end
        -- 完整复现需要全参数：记录该 FX 实例的完整参数快照（名字+格式化值+归一化值）
        local fx_snapshot = { __json_array = true }
        for p3 = 0, reaper.TrackFX_GetNumParams(track, fx_index) - 1 do
          local _, pn3 = reaper.TrackFX_GetParamName(track, fx_index, p3, "")
          -- REAPER 给每台插件附加 128 个 MIDI CC 学习伪参数，不是插件状态，剔除
          if pn3 ~= nil and not pn3:match("^MIDI") then
            local _, pf3 = reaper.TrackFX_GetFormattedParamValue(track, fx_index, p3, "")
            local pv3 = reaper.TrackFX_GetParamNormalized(track, fx_index, p3)
            fx_snapshot[#fx_snapshot + 1] = { name = pn3, formatted = pf3, normalized = pv3 }
          end
        end
        adjustments[#adjustments + 1] = {
          actionIndex = action_index - 1,
          track = action.track.name,
          plugin = action.fx,
          parameter = action.parameter,
          parameterName = param_name,
          before = before,
          after = after,
          beforeFormatted = before_fmt,
          afterFormatted = after_fmt,
          parameterContext = param_context,
          fxSnapshot = fx_snapshot,
          reason = action.reason,
        }
      end
    end
    reaper.UpdateArrange()
    return { projectId = project_snapshot().project_id, adjustments = adjustments }
  end, debug.traceback)
  reaper.Undo_EndBlock2(project, "REAPER Mixing Agent: apply natural-language mix plan", -1)
  reaper.PreventUIRefresh(-1)
  if not ok then
    reaper.Undo_DoUndo2(project)
    error(result)
  end
  return result
end

local function path_is_inside_artifact_root(path)
  local prefix = artifact_root:gsub("[\\/]$", "") .. "/"
  if path:sub(1, #prefix) ~= prefix then return false end
  if path:find("/%.%./", 1, false) or path:find("\\%.%.\\", 1, false) then return false end
  return true
end

local function project_track_for_artifact(project, artifact_id)
  local marker = "RMA_ARTIFACT:" .. artifact_id
  for track_index = 0, reaper.CountTracks(project) - 1 do
    local track = reaper.GetTrack(project, track_index)
    for item_index = 0, reaper.CountTrackMediaItems(track) - 1 do
      local item = reaper.GetTrackMediaItem(track, item_index)
      for take_index = 0, reaper.CountTakes(item) - 1 do
        local take = reaper.GetTake(item, take_index)
        if take then
          local _, name = reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "", false)
          if name == marker then return track end
        end
      end
    end
  end
  return nil
end

local function validated_track_name(value)
  if type(value) ~= "string" or value == "" or #value > 128 or value:find("[%c]") then
    error("media track name must be 1 to 128 printable characters")
  end
  return value
end

local function unique_track_name(project, requested)
  local used = {}
  for index = 0, reaper.CountTracks(project) - 1 do
    local track = reaper.GetTrack(project, index)
    local _, name = reaper.GetTrackName(track, "")
    used[name] = true
  end
  if not used[requested] then return requested end
  local suffix = 2
  while used[requested .. " (" .. suffix .. ")"] do suffix = suffix + 1 end
  return requested .. " (" .. suffix .. ")"
end

local function import_media(payload)
  if type(payload.files) ~= "table" or not payload.files.__json_array
    or #payload.files < 1 or #payload.files > 16
  then
    error("media import requires 1 to 16 files")
  end
  local project = reaper.EnumProjects(-1, "")
  local imported = { __json_array = true }
  reaper.PreventUIRefresh(1)
  reaper.Undo_BeginBlock2(project)
  local ok, result = xpcall(function()
    for _, file in ipairs(payload.files) do
      if type(file.artifactId) ~= "string" or not file.artifactId:match("^artifact:[0-9a-f]+$") then
        error("invalid media artifact id")
      end
      if type(file.path) ~= "string" or not path_is_inside_artifact_root(file.path) then
        error("media path must stay inside artifact root")
      end
      local requested_track_name = validated_track_name(file.trackName)
      local existing_track = project_track_for_artifact(project, file.artifactId)
      if existing_track then
        local _, existing_name = reaper.GetTrackName(existing_track, "")
        imported[#imported + 1] = {
          artifactId = file.artifactId,
          trackGuid = reaper.GetTrackGUID(existing_track),
          trackName = existing_name,
          alreadyPlaced = true,
        }
      else
        local source = reaper.PCM_Source_CreateFromFile(file.path)
        if not source then error("unable to open media artifact") end
        local track_index = reaper.CountTracks(project)
        reaper.InsertTrackAtIndex(track_index, true)
        local track = reaper.GetTrack(project, track_index)
        if not track then error("unable to create source track") end
        local actual_track_name = unique_track_name(project, requested_track_name)
        reaper.GetSetMediaTrackInfo_String(track, "P_NAME", actual_track_name, true)
        local item = reaper.AddMediaItemToTrack(track)
        local take = item and reaper.AddTakeToMediaItem(item) or nil
        if not item or not take then error("unable to create media item") end
        reaper.SetMediaItemTake_Source(take, source)
        local length = reaper.GetMediaSourceLength(source)
        if type(length) ~= "number" or length <= 0 then error("media artifact is empty") end
        reaper.SetMediaItemInfo_Value(item, "D_POSITION", 0)
        reaper.SetMediaItemInfo_Value(item, "D_LENGTH", length)
        reaper.GetSetMediaItemTakeInfo_String(take, "P_NAME", "RMA_ARTIFACT:" .. file.artifactId, true)
        imported[#imported + 1] = {
          artifactId = file.artifactId,
          trackGuid = reaper.GetTrackGUID(track),
          trackName = actual_track_name,
          durationSeconds = length,
          alreadyPlaced = false,
        }
      end
    end
    reaper.UpdateArrange()
    return { projectId = project_snapshot().project_id, imported = imported }
  end, debug.traceback)
  reaper.Undo_EndBlock2(project, "REAPER Mixing Agent: import durable media artifacts", -1)
  reaper.PreventUIRefresh(-1)
  if not ok then
    reaper.Undo_DoUndo2(project)
    error(result)
  end
  return result
end

local function project_is_open(target)
  local index = 0
  while true do
    local project = reaper.EnumProjects(index, "")
    if not project then return false end
    if project == target then return true end
    index = index + 1
  end
end

local function discard_project_without_prompt(project, temporary_path)
  reaper.SelectProjectInstance(project)
  reaper.Main_SaveProjectEx(project, temporary_path, 8)
  local current, saved_path = reaper.EnumProjects(-1, "")
  if current ~= project or saved_path ~= temporary_path then
    error("unable to stage project discard")
  end
  reaper.Main_OnCommand(40860, 0)
  if project_is_open(project) then error("REAPER did not close discarded project") end
  os.remove(temporary_path)
  os.remove(temporary_path .. "-bak")
end

local function rebuild_project(payload)
  for key in pairs(payload) do
    if key ~= "schema" and key ~= "projectName" and key ~= "projectPath"
      and key ~= "discardCurrent" and key ~= "files"
    then
      error("unknown project rebuild field: " .. tostring(key))
    end
  end
  if payload.schema ~= "rma.project-rebuild/v1" then error("unsupported project rebuild schema") end
  validated_track_name(payload.projectName)
  if type(payload.projectPath) ~= "string" or not path_is_inside_artifact_root(payload.projectPath)
    or not payload.projectPath:lower():match("%.rpp$")
  then
    error("project path must be an RPP inside artifact root")
  end
  if type(payload.discardCurrent) ~= "boolean" then error("discardCurrent must be boolean") end
  if type(payload.files) ~= "table" or not payload.files.__json_array
    or #payload.files < 1 or #payload.files > 64
  then
    error("project rebuild requires 1 to 64 files")
  end
  local artifact_ids = {}
  local track_names = {}
  for _, file in ipairs(payload.files) do
    if type(file) ~= "table" or type(file.artifactId) ~= "string"
      or not file.artifactId:match("^artifact:[0-9a-f]+$")
    then
      error("invalid project material artifact id")
    end
    if artifact_ids[file.artifactId] then error("project material is assigned more than once") end
    artifact_ids[file.artifactId] = true
    if type(file.path) ~= "string" or not path_is_inside_artifact_root(file.path) then
      error("project material path must stay inside artifact root")
    end
    local track_name = validated_track_name(file.trackName)
    local normalized_name = track_name:lower()
    if track_names[normalized_name] then error("project track names must be unique") end
    track_names[normalized_name] = true
  end
  local project_directory = payload.projectPath:match("^(.*)[/\\][^/\\]+$")
  if not project_directory then error("project path has no parent directory") end
  reaper.RecursiveCreateDirectory(project_directory, 0)
  local existing = io.open(payload.projectPath, "rb")
  if existing then
    existing:close()
    error("project output already exists")
  end

  local previous_project, previous_path = reaper.EnumProjects(-1, "")
  local previous_id = previous_path ~= "" and previous_path or ("unsaved:" .. bridge_instance_id)
  reaper.Main_OnCommand(40859, 0)
  local new_project = reaper.EnumProjects(-1, "")
  if not new_project or new_project == previous_project or reaper.CountTracks(new_project) ~= 0 then
    error("REAPER did not create an empty project tab")
  end

  local success, result = xpcall(function()
    reaper.GetSetProjectInfo(new_project, "PROJECT_SRATE", 48000, true)
    local imported = import_media({ files = payload.files })
    if #imported.imported ~= #payload.files then error("project rebuild placement count mismatch") end
    reaper.Main_SaveProjectEx(new_project, payload.projectPath, 8)
    local current, saved_path = reaper.EnumProjects(-1, "")
    if current ~= new_project or saved_path ~= payload.projectPath then
      error("REAPER did not save the rebuilt project")
    end
    local snapshot = project_snapshot()
    if snapshot.track_count ~= #payload.files then error("rebuilt project track count mismatch") end
    if payload.discardCurrent then
      discard_project_without_prompt(
        previous_project,
        payload.projectPath .. ".discard-" .. tostring(math.floor(reaper.time_precise() * 1000000)) .. ".rpp"
      )
      reaper.SelectProjectInstance(new_project)
      if reaper.EnumProjects(-1, "") ~= new_project then error("unable to reactivate rebuilt project") end
    end
    return {
      schema = "rma.project-rebuild-receipt/v1",
      previousProjectId = previous_id,
      previousProjectDiscarded = payload.discardCurrent,
      project = project_snapshot(),
      placements = imported.imported,
    }
  end, debug.traceback)

  if not success then
    if project_is_open(new_project) then
      local cleanup_path = payload.projectPath .. ".failed-" .. tostring(math.floor(reaper.time_precise() * 1000000)) .. ".rpp"
      local cleanup_ok = pcall(discard_project_without_prompt, new_project, cleanup_path)
      if not cleanup_ok then reaper.SelectProjectInstance(previous_project) end
    end
    if project_is_open(previous_project) then reaper.SelectProjectInstance(previous_project) end
    error(result)
  end
  return result
end

local function ensure_audio_engine_ready()
  -- REAPER can keep the project DSP graph alive while the CoreAudio device has
  -- fallen to 0 outputs. In that state playback meters still move, but action
  -- 42230 renders only the plug-in noise floor. Audio_Init is synchronous on
  -- the supported REAPER/macOS bridge and is safe to call before each render.
  reaper.Audio_Init()
  if reaper.GetNumAudioOutputs() <= 0 then
    error("REAPER audio engine has no output channels after Audio_Init")
  end
end

local function render_project(payload)
  if type(payload.outputPath) ~= "string" or not path_is_inside_artifact_root(payload.outputPath) then
    error("render path must stay inside artifact root")
  end
  if payload.format ~= "wav" or payload.sampleRate ~= 48000 or payload.channels ~= 2 then
    error("render must be stereo 48 kHz WAV")
  end
  if type(payload.tailSeconds) ~= "number" or payload.tailSeconds < 0 or payload.tailSeconds > 10 then
    error("invalid render tail")
  end
  local directory, filename = payload.outputPath:match("^(.*)/([^/]+%.wav)$")
  if not directory or not filename or not filename:match("^[A-Za-z0-9._-]+%.wav$") then
    error("invalid render output filename")
  end
  local existing = io.open(payload.outputPath, "rb")
  if existing then
    existing:close()
    error("render output already exists")
  end
  reaper.RecursiveCreateDirectory(directory, 0)
  local project = reaper.EnumProjects(-1, "")
  if reaper.GetProjectLength(project) <= 0 then error("project has no renderable duration") end

  local numeric_keys = {
    "RENDER_SETTINGS", "RENDER_BOUNDSFLAG", "RENDER_CHANNELS", "RENDER_SRATE",
    "RENDER_TAILFLAG", "RENDER_TAILMS", "RENDER_ADDTOPROJ", "RENDER_NORMALIZE",
  }
  local string_keys = { "RENDER_FILE", "RENDER_PATTERN", "RENDER_FORMAT", "RENDER_FORMAT2" }
  local previous_numeric = {}
  local previous_string = {}
  for _, key in ipairs(numeric_keys) do
    previous_numeric[key] = reaper.GetSetProjectInfo(project, key, 0, false)
  end
  for _, key in ipairs(string_keys) do
    local _, value = reaper.GetSetProjectInfo_String(project, key, "", false)
    previous_string[key] = value
  end

  local ok, result = xpcall(function()
    ensure_audio_engine_ready()
    reaper.GetSetProjectInfo(project, "RENDER_SETTINGS", 0, true)
    reaper.GetSetProjectInfo(project, "RENDER_BOUNDSFLAG", 1, true)
    reaper.GetSetProjectInfo(project, "RENDER_CHANNELS", 2, true)
    reaper.GetSetProjectInfo(project, "RENDER_SRATE", 48000, true)
    reaper.GetSetProjectInfo(project, "RENDER_TAILFLAG", payload.tailSeconds > 0 and 2 or 0, true)
    reaper.GetSetProjectInfo(project, "RENDER_TAILMS", payload.tailSeconds * 1000, true)
    reaper.GetSetProjectInfo(project, "RENDER_ADDTOPROJ", 0, true)
    reaper.GetSetProjectInfo(project, "RENDER_NORMALIZE", 0, true)
    reaper.GetSetProjectInfo_String(project, "RENDER_FILE", directory, true)
    reaper.GetSetProjectInfo_String(project, "RENDER_PATTERN", filename:sub(1, -5), true)
    reaper.GetSetProjectInfo_String(project, "RENDER_FORMAT", "evaw", true)
    reaper.GetSetProjectInfo_String(project, "RENDER_FORMAT2", "", true)
    reaper.Main_OnCommandEx(42230, 0, project)
    local rendered = io.open(payload.outputPath, "rb")
    if not rendered then error("REAPER did not create the render artifact") end
    rendered:close()
    return { path = payload.outputPath, sampleRate = 48000, channels = 2, format = "wav" }
  end, debug.traceback)

  for _, key in ipairs(numeric_keys) do
    reaper.GetSetProjectInfo(project, key, previous_numeric[key], true)
  end
  for _, key in ipairs(string_keys) do
    reaper.GetSetProjectInfo_String(project, key, previous_string[key], true)
  end
  if not ok then error(result) end
  return result
end

local analysis_meter_name = "JS: analysis/loudness_meter"
local analysis_undo_label = "REAPER Mixing Agent: transient loudness analysis"

local analysis_parameter_names = {
  ["Peak/True peak dB (output)"] = "peakDb",
  ["RMS-M (output)"] = "rmsMomentaryDb",
  ["RMS-I (output)"] = "rmsIntegratedDb",
  ["LUFS-M (output)"] = "lufsMomentary",
  ["LUFS-S (output)"] = "lufsShortTerm",
  ["LUFS-I (output)"] = "lufsIntegrated",
  ["LRA (output)"] = "loudnessRangeDb",
}

local function fx_topology(project)
  local parts = {}
  for track_index = 0, reaper.CountTracks(project) - 1 do
    local track = reaper.GetTrack(project, track_index)
    parts[#parts + 1] = reaper.GetTrackGUID(track)
    for fx_index = 0, reaper.TrackFX_GetCount(track) - 1 do
      parts[#parts + 1] = reaper.TrackFX_GetFXGUID(track, fx_index)
    end
  end
  return table.concat(parts, "\0")
end

local function read_analysis_meter(track, fx_index)
  local values = {}
  for parameter_index = 0, reaper.TrackFX_GetNumParams(track, fx_index) - 1 do
    local _, parameter_name = reaper.TrackFX_GetParamName(track, fx_index, parameter_index, "")
    local field = analysis_parameter_names[parameter_name]
    if field then
      values[field] = reaper.TrackFX_GetParam(track, fx_index, parameter_index)
    end
  end
  for _, field in pairs(analysis_parameter_names) do
    if type(values[field]) ~= "number" then
      error("analysis meter omitted " .. field)
    end
  end
  values.hasSignal = values.peakDb > -120
  return values
end

local function capture_analysis(payload)
  local project = reaper.EnumProjects(-1, "")
  local before_topology = fx_topology(project)
  local inserted = {}
  local tracks = { __json_array = true }
  reaper.PreventUIRefresh(1)
  reaper.Undo_BeginBlock2(project)
  local ok, result = xpcall(function()
    for track_index = 0, reaper.CountTracks(project) - 1 do
      local track = reaper.GetTrack(project, track_index)
      local fx_index = reaper.TrackFX_AddByName(track, analysis_meter_name, false, -1)
      if fx_index < 0 then error("unable to insert transient loudness meter") end
      inserted[#inserted + 1] = { track = track, fx_index = fx_index }
    end
    render_project(payload)
    for track_index, meter in ipairs(inserted) do
      local track = meter.track
      local _, track_name = reaper.GetTrackName(track, "")
      local values = read_analysis_meter(track, meter.fx_index)
      tracks[#tracks + 1] = {
        trackGuid = reaper.GetTrackGUID(track),
        name = track_name,
        index = track_index - 1,
        hasSignal = values.hasSignal,
        peakDb = values.peakDb,
        rmsMomentaryDb = values.rmsMomentaryDb,
        rmsIntegratedDb = values.rmsIntegratedDb,
        lufsMomentary = values.lufsMomentary,
        lufsShortTerm = values.lufsShortTerm,
        lufsIntegrated = values.lufsIntegrated,
        loudnessRangeDb = values.loudnessRangeDb,
      }
    end
    return {
      schema = "rma.mix-analysis/v1",
      projectId = project_snapshot().project_id,
      projectChangeCount = reaper.GetProjectStateChangeCount(project),
      analyzedAt = now_iso(),
      tracks = tracks,
    }
  end, debug.traceback)
  reaper.Undo_EndBlock2(project, analysis_undo_label, -1)
  reaper.PreventUIRefresh(-1)

  local undo_label = reaper.Undo_CanUndo2(project)
  if undo_label ~= analysis_undo_label or reaper.Undo_DoUndo2(project) == 0 then
    error("RMA_ANALYSIS_RECOVERY_REQUIRED: transient meter Undo checkpoint is unavailable")
  end
  if fx_topology(project) ~= before_topology then
    error("RMA_ANALYSIS_RECOVERY_REQUIRED: transient meter topology was not restored")
  end
  if not ok then error(result) end
  local topology = project_snapshot()
  local topology_by_guid = {}
  for _, track in ipairs(topology.tracks) do topology_by_guid[track.guid] = track end
  for _, track in ipairs(result.tracks) do
    local observed = topology_by_guid[track.trackGuid]
    if not observed or observed.name ~= track.name then
      error("RMA_ANALYSIS_RECOVERY_REQUIRED: track topology changed during analysis")
    end
    track.mediaItemCount = observed.media_item_count
    track.mainSend = observed.main_send
    track.fx = observed.fx
    track.sends = observed.sends
  end
  result.projectChangeCount = topology.project_change_count
  return result
end

local function generate_reascript_docs(payload)
  for key in pairs(payload) do error("unknown docs.generate field: " .. tostring(key)) end
  local temp_directory = os.getenv("TMPDIR")
  if type(temp_directory) ~= "string" or temp_directory == "" then
    error("REAPER temporary directory is unavailable")
  end
  reaper.Main_OnCommand(41065, 0)
  return {
    fileName = "reascripthelp.html",
    reaperVersion = reaper.GetAppVersion(),
    tempDirectory = temp_directory,
  }
end

local allowed_envelope_keys = {
  schema = true,
  protocol_version = true,
  command_id = true,
  session_id = true,
  bridge_instance_id = true,
  created_at = true,
  deadline_at = true,
  operation = true,
  expected_project_id = true,
  expected_snapshot_hash = true,
  payload = true,
  payload_sha256 = true,
}

local function validate_command(command, file_command_id)
  if type(command) ~= "table" or command.__json_array then return nil, "command must be an object" end
  for key in pairs(command) do
    if not allowed_envelope_keys[key] then return nil, "unknown envelope field" end
  end
  if command.schema ~= "rma.bridge-command/v1" then return nil, "unsupported schema" end
  if command.protocol_version ~= 1 then return nil, "unsupported protocol" end
  if type(command.command_id) ~= "string"
    or not command.command_id:match("^[0-9a-fA-F]+%-[0-9a-fA-F]+%-[0-9a-fA-F]+%-[0-9a-fA-F]+%-[0-9a-fA-F]+$")
    or command.command_id ~= file_command_id
  then
    return nil, "invalid command id"
  end
  if type(command.session_id) ~= "string" or command.session_id:find("[%c]") then
    return nil, "invalid session id"
  end
  if command.bridge_instance_id ~= bridge_instance_id then return nil, "bridge instance mismatch" end
  if not parse_utc_timestamp(command.created_at) or not parse_utc_timestamp(command.deadline_at) then
    return nil, "invalid timestamps"
  end
  if type(command.payload) ~= "table" or command.payload.__json_array then return nil, "payload must be an object" end
  if type(command.payload_sha256) ~= "string"
    or not command.payload_sha256:match("^sha256:[0-9a-f]+$")
    or #command.payload_sha256 ~= 71
  then
    return nil, "invalid payload hash"
  end
  if command.operation ~= "bridge.health"
    and command.operation ~= "project.snapshot"
    and command.operation ~= "analysis.capture"
    and command.operation ~= "project.bootstrap"
    and command.operation ~= "project.rebuild"
    and command.operation ~= "media.import"
    and command.operation ~= "fx.probe"
    and command.operation ~= "docs.generate"
    and command.operation ~= "transaction.execute"
    and command.operation ~= "render.create"
  then
    return nil, "unknown operation"
  end
  return true
end

local active_command_id = JSON_NULL
local bridge_state = "idle"

local function receipt(command_id, status, started_at, result, error_message)
  return {
    schema = "rma.bridge-receipt/v1",
    protocol_version = 1,
    command_id = command_id,
    status = status,
    started_at = started_at,
    finished_at = now_iso(),
    artifacts = { __json_array = true },
    warnings = { __json_array = true },
    error = error_message and { code = "RMA_BRIDGE_REJECTED", message = error_message } or JSON_NULL,
    result = result or JSON_NULL,
  }
end

local function write_heartbeat()
  local snapshot = project_snapshot()
  atomic_write(paths.heartbeat, paths.command_tmp, {
    schema = "rma.bridge-heartbeat/v1",
    bridge_instance_id = bridge_instance_id,
    protocol_version = 1,
    observed_at = now_iso(),
    reaper_version = reaper.GetAppVersion(),
    project_id = snapshot.project_id,
    project_change_count = snapshot.project_change_count,
    state = bridge_state,
    active_command_id = active_command_id,
  })
end

local function next_ready_command()
  local files = {}
  local index = 0
  while true do
    local name = reaper.EnumerateFiles(paths.command_ready, index)
    if not name then break end
    if name:match("^[0-9a-fA-F%-]+%.json$") then files[#files + 1] = name end
    index = index + 1
  end
  table.sort(files)
  return files[1]
end

local function process_one_command()
  if bridge_state == "recovery_required" then return end
  local filename = next_ready_command()
  if not filename then return end
  local command_id = filename:sub(1, -6)
  local ready_path = paths.command_ready .. "/" .. filename
  local claimed_path = paths.command_claimed .. "/" .. filename
  if not os.rename(ready_path, claimed_path) then return end

  active_command_id = command_id
  bridge_state = "busy"
  local started_at = now_iso()
  local output
  local source, read_error = read_file(claimed_path)
  if not source then
    output = receipt(command_id, "failed", started_at, nil, "unable to read claimed command: " .. read_error)
  else
    local parsed_ok, command = pcall(decode_json, source)
    if not parsed_ok then
      output = receipt(command_id, "rejected", started_at, nil, tostring(command))
    else
      local valid, validation_error = validate_command(command, command_id)
      if not valid then
        output = receipt(command_id, "rejected", started_at, nil, validation_error)
      elseif deadline_expired(command.deadline_at) then
        output = receipt(command_id, "rejected", started_at, nil, "command deadline expired")
      elseif command.expected_project_id and command.expected_project_id ~= project_snapshot().project_id then
        output = receipt(command_id, "rejected", started_at, nil, "project precondition failed")
      elseif command.operation == "bridge.health" then
        output = receipt(command_id, "succeeded", started_at, {
          state = "idle",
          bridge_instance_id = bridge_instance_id,
          reaper_version = reaper.GetAppVersion(),
        })
      elseif command.operation == "project.snapshot" then
        output = receipt(command_id, "succeeded", started_at, project_snapshot())
      elseif command.operation == "analysis.capture" then
        local analysis_ok, analysis_result = xpcall(function()
          return capture_analysis(command.payload)
        end, debug.traceback)
        if analysis_ok then
          output = receipt(command_id, "succeeded", started_at, analysis_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(analysis_result))
        end
      elseif command.operation == "project.bootstrap" then
        local bootstrap_ok, bootstrap_result = xpcall(function()
          return bootstrap_project(command.payload)
        end, debug.traceback)
        if bootstrap_ok then
          output = receipt(command_id, "succeeded", started_at, bootstrap_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(bootstrap_result))
        end
      elseif command.operation == "project.rebuild" then
        local rebuild_ok, rebuild_result = xpcall(function()
          return rebuild_project(command.payload)
        end, debug.traceback)
        if rebuild_ok then
          output = receipt(command_id, "succeeded", started_at, rebuild_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(rebuild_result))
        end
      elseif command.operation == "media.import" then
        local import_ok, import_result = xpcall(function()
          return import_media(command.payload)
        end, debug.traceback)
        if import_ok then
          output = receipt(command_id, "succeeded", started_at, import_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(import_result))
        end
      elseif command.operation == "fx.probe" then
        local probe_ok, probe_result = xpcall(function()
          return probe_fx(command.payload)
        end, debug.traceback)
        if probe_ok then
          output = receipt(command_id, "succeeded", started_at, probe_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(probe_result))
        end
      elseif command.operation == "docs.generate" then
        local generate_ok, generate_result = xpcall(function()
          return generate_reascript_docs(command.payload)
        end, debug.traceback)
        if generate_ok then
          output = receipt(command_id, "succeeded", started_at, generate_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(generate_result))
        end
      elseif command.operation == "transaction.execute" then
        local execute_ok, execute_result = xpcall(function()
          return execute_transaction(command.payload)
        end, debug.traceback)
        if execute_ok then
          output = receipt(command_id, "succeeded", started_at, execute_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(execute_result))
        end
      elseif command.operation == "render.create" then
        local render_ok, render_result = xpcall(function()
          return render_project(command.payload)
        end, debug.traceback)
        if render_ok then
          output = receipt(command_id, "succeeded", started_at, render_result)
        else
          output = receipt(command_id, "failed", started_at, nil, tostring(render_result))
        end
      else
        output = receipt(command_id, "rejected", started_at, nil, "unknown operation")
      end
    end
  end

  local receipt_written, receipt_error = atomic_write(
    paths.receipt_ready .. "/" .. filename,
    paths.receipt_tmp,
    output
  )
  if receipt_written then
    os.rename(claimed_path, paths.command_finished .. "/" .. filename)
    active_command_id = JSON_NULL
    bridge_state = "idle"
  else
    bridge_state = "recovery_required"
    reaper.ShowConsoleMsg(
      "REAPER Mixing Agent could not persist receipt for "
        .. command_id
        .. ": "
        .. tostring(receipt_error)
        .. "\n"
    )
  end
end

local last_heartbeat = 0
local function loop()
  local ok, message = xpcall(process_one_command, debug.traceback)
  if not ok then
    bridge_state = "recovery_required"
    reaper.ShowConsoleMsg("REAPER Mixing Agent bridge error: " .. tostring(message) .. "\n")
  end
  local now = reaper.time_precise()
  if now - last_heartbeat >= 1 then
    write_heartbeat()
    last_heartbeat = now
  end
  reaper.defer(loop)
end

write_heartbeat()
last_heartbeat = reaper.time_precise()
reaper.defer(loop)
