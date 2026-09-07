-- One-shot render worker. This file is launched by the TypeScript runtime via
-- `REAPER -nonewinst`; it must not be called from the persistent bridge's
-- reaper.defer callback because REAPER then renders only the plug-in noise floor.

return function(job)
  if type(job) ~= "table" then error("render worker job must be a table") end
  if type(job.expectedProjectId) ~= "string" or job.expectedProjectId == "" then
    error("render worker expected project id is required")
  end
  if type(job.outputPath) ~= "string" or not job.outputPath:match("%.wav$") then
    error("render worker output path must be WAV")
  end
  if type(job.tailSeconds) ~= "number" or job.tailSeconds < 0 or job.tailSeconds > 10 then
    error("render worker tail must be between 0 and 10 seconds")
  end

  local project, project_path = reaper.EnumProjects(-1, "")
  if project_path ~= job.expectedProjectId then
    error("render worker project precondition failed")
  end
  if reaper.GetProjectLength(project) <= 0 then error("project has no renderable duration") end

  local directory, filename = job.outputPath:match("^(.*)/([^/]+%.wav)$")
  if not directory or not filename or not filename:match("^[A-Za-z0-9._-]+%.wav$") then
    error("invalid render worker output filename")
  end
  local existing = io.open(job.outputPath, "rb")
  if existing then existing:close() error("render worker output already exists") end
  reaper.RecursiveCreateDirectory(directory, 0)

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
    -- A stale CoreAudio graph may still report output channels while scripted
    -- renders contain only plug-in noise. A full teardown/re-init is required;
    -- Audio_Init by itself does not recover that state.
    reaper.Audio_Quit()
    reaper.Audio_Init()
    if reaper.GetNumAudioOutputs() <= 0 then
      error("REAPER audio engine has no output channels after Audio_Init")
    end
    reaper.GetSetProjectInfo(project, "RENDER_SETTINGS", 0, true)
    reaper.GetSetProjectInfo(project, "RENDER_BOUNDSFLAG", 1, true)
    reaper.GetSetProjectInfo(project, "RENDER_CHANNELS", 2, true)
    reaper.GetSetProjectInfo(project, "RENDER_SRATE", 48000, true)
    reaper.GetSetProjectInfo(project, "RENDER_TAILFLAG", job.tailSeconds > 0 and 2 or 0, true)
    reaper.GetSetProjectInfo(project, "RENDER_TAILMS", job.tailSeconds * 1000, true)
    reaper.GetSetProjectInfo(project, "RENDER_ADDTOPROJ", 0, true)
    reaper.GetSetProjectInfo(project, "RENDER_NORMALIZE", 0, true)
    reaper.GetSetProjectInfo_String(project, "RENDER_FILE", directory, true)
    reaper.GetSetProjectInfo_String(project, "RENDER_PATTERN", filename:sub(1, -5), true)
    reaper.GetSetProjectInfo_String(project, "RENDER_FORMAT", "evaw", true)
    reaper.GetSetProjectInfo_String(project, "RENDER_FORMAT2", "", true)
    reaper.Main_OnCommandEx(42230, 0, project)
    local rendered = io.open(job.outputPath, "rb")
    if not rendered then error("REAPER did not create the render artifact") end
    rendered:close()
    return true
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
