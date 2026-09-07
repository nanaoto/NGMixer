-- MixingNiuma project switch template.
-- Usage: copy to /tmp, fill TARGET_PATH, run via REAPER binary.
-- Idempotent: if TARGET is already the current project, no-ops.
-- Saves the current project before switching; aborts if the open fails.
local TARGET_PATH = "__TARGET_PATH__"
local OUT = "/tmp/rma-script/switch.out"

local out = io.open(OUT, "w")
local function log(s) out:write(s, "\n") out:flush() end
local proj, cur = reaper.EnumProjects(-1, "")
log("current: " .. tostring(cur))
if cur == TARGET_PATH then
  log("NO-OP: target already current")
  out:close()
  return
end
local f = io.open(TARGET_PATH, "r")
if not f then log("ABORT: target missing: " .. TARGET_PATH) out:close() return end
f:close()
reaper.Main_SaveProject(proj, false)
log("saved current")
reaper.Main_openProject(TARGET_PATH)
local proj2, now = reaper.EnumProjects(-1, "")
if now ~= TARGET_PATH then
  log("FAILED: after open, current is " .. tostring(now))
else
  log("SWITCHED -> " .. now)
end
out:close()
