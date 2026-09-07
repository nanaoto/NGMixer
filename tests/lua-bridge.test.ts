import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Lua bridge has a read path and an undoable empty-project bootstrap", async () => {
  const script = await readFile(new URL("../reaper/MixingAgentBridge.lua", import.meta.url), "utf8");

  assert.match(script, /GetExtState\("reaper_mixing_agent", "runtime_root"\)/);
  assert.match(script, /GetExtState\("reaper_mixing_agent", "bridge_instance_id"\)/);
  assert.match(script, /bridge\.health/);
  assert.match(script, /project\.snapshot/);
  assert.match(script, /analysis\.capture/);
  assert.match(script, /project\.bootstrap/);
  assert.match(script, /project\.rebuild/);
  assert.match(script, /media\.import/);
  assert.match(script, /fx\.probe/);
  assert.match(script, /docs\.generate/);
  assert.match(script, /transaction\.execute/);
  assert.match(script, /render\.create/);
  assert.match(script, /reaper\.defer/);
  assert.match(script, /GetProjectStateChangeCount/);
  assert.match(script, /TrackFX_GetFXGUID/);
  assert.match(script, /Undo_BeginBlock2/);
  assert.match(script, /Undo_DoUndo2/);
  assert.match(script, /InsertTrackAtIndex/);
  assert.match(script, /PCM_Source_CreateFromFile/);
  assert.match(script, /RMA_ARTIFACT:/);
  assert.match(script, /media path must stay inside artifact root/);
  assert.match(script, /local function unique_track_name\(project, requested\)/);
  assert.match(script, /reaper\.InsertTrackAtIndex\(track_index, true\)/);
  assert.match(script, /trackGuid = reaper\.GetTrackGUID\(track\)/);
  assert.match(script, /alreadyPlaced = false/);
  assert.doesNotMatch(script, /allowed_target_tracks/);
  assert.match(script, /local function find_track_by_identity\(project, identity\)/);
  assert.match(script, /track identity changed/);
  assert.match(script, /CreateTrackSend/);
  assert.match(script, /TrackFX_GetParamFromIdent\(track, fx_index, ":wet"\)/);
  assert.match(script, /project must be empty/);
  assert.match(script, /Main_OnCommand\(40859, 0\)/);
  assert.match(script, /Main_SaveProjectEx\(new_project, payload\.projectPath, 8\)/);
  assert.match(script, /Main_OnCommand\(40860, 0\)/);
  assert.match(script, /project rebuild placement count mismatch/);
  assert.match(script, /previousProjectDiscarded = payload\.discardCurrent/);
  assert.match(script, /Undo_BeginBlock2[\s\S]*execute_transaction[\s\S]*Undo_DoUndo2/);
  assert.match(script, /TrackFX_GetParamName/);
  assert.match(script, /TrackFX_GetParam\(track, fx_index, parameter_index\)/);
  assert.match(script, /TrackFX_GetParamIdent/);
  assert.match(script, /TrackFX_GetFormattedParamValue/);
  assert.match(script, /local function probe_fx\(payload\)/);
  assert.match(script, /\["Pro-Q 4 \(FabFilter\)"\] = true/);
  assert.match(script, /\["Pro-C 2 \(FabFilter\)"\] = true/);
  assert.match(script, /\["Pro-DS \(FabFilter\)"\] = true/);
  assert.match(script, /\["Pro-L 2 \(FabFilter\)"\] = true/);
  assert.match(script, /probe_fx[\s\S]*InsertTrackAtIndex[\s\S]*TrackFX_AddByName[\s\S]*DeleteTrack/);
  assert.match(script, /transient FabFilter probe[\s\S]*Undo_DoUndo2\(project\)/);
  assert.match(script, /semantic:compressorThreshold/);
  assert.match(script, /semantic:deesserThreshold/);
  assert.match(script, /local mix_action_plugins =/);
  assert.match(script, /mix_action_plugins\[action\.fx\]/);
  assert.match(script, /TrackFX_GetFXGUID\(track, index\) == action\.fxGuid/);
  assert.match(script, /TrackFX_GetParamFromIdent\(track, fx_index, action\.parameterIdent\)/);
  assert.match(script, /proven FabFilter instance is disabled or offline/);
  assert.match(script, /targeted FX probe requires track identity and fxGuid/);
  assert.match(script, /FX probe format must be VST3 or CLAP/);
  assert.match(script, /action\.fxFormat \.\. ": " \.\. action\.fx/);
  assert.match(script, /gainhighshelf/);
  assert.match(script, /FX parameter adjustment reached its limit without changing value/);
  assert.match(script, /RENDER_BOUNDSFLAG/);
  assert.match(script, /RENDER_FORMAT/);
  assert.match(
    script,
    /local function ensure_audio_engine_ready\(\)[\s\S]*reaper\.Audio_Init\(\)[\s\S]*GetNumAudioOutputs\(\)[\s\S]*audio engine has no output channels/,
  );
  assert.match(script, /ensure_audio_engine_ready\(\)[\s\S]*Main_OnCommandEx\(42230, 0, project\)/);
  assert.doesNotMatch(script, /Main_OnCommand\(42230, 0\)/);
  assert.match(script, /Main_OnCommand\(41065, 0\)/);
  assert.match(script, /tempDirectory = temp_directory/);
  assert.match(script, /render path must stay inside artifact root/);
  assert.match(script, /JS: analysis\/loudness_meter/);
  assert.match(script, /transient loudness analysis/);
  assert.match(script, /Undo_CanUndo2\(project\)/);
  assert.match(script, /transient meter topology was not restored/);
});

test("Lua bridge documents and enforces its generated-envelope parser boundary", async () => {
  const script = await readFile(new URL("../reaper/MixingAgentBridge.lua", import.meta.url), "utf8");

  assert.match(script, /generated command envelope/);
  assert.match(script, /strict JSON decoder/);
  assert.match(script, /rma\.bridge-command\/v1/);
  assert.match(script, /unknown operation/);
  assert.match(script, /local function deadline_expired\(deadline_at\)/);
  assert.match(script, /command deadline expired/);
  assert.match(script, /local receipt_written, receipt_error = atomic_write/);
  assert.match(script, /if receipt_written then[\s\S]*command_finished/);
  assert.match(script, /bridge_state = "recovery_required"/);
});
