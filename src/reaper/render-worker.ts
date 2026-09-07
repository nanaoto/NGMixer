import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

import type { BridgeReceipt, JsonValue } from "../bridge/protocol.js";
import type { BridgeRequest, BridgeRequester } from "../mixing/reaper-mix-engine.js";

const execFile = promisify(execFileCallback);

export interface ReaperRenderRequest {
  readonly expectedProjectId: string;
  readonly outputPath: string;
  readonly tailSeconds: number;
  readonly timeoutMs: number;
}

export interface ReaperRenderWorker {
  render(request: ReaperRenderRequest): Promise<void>;
}

interface WorkerLaunchRequest {
  readonly phase: "warmup" | "render";
  readonly wrapperPath: string;
  readonly completionPath: string;
  readonly outputPath: string;
}

export interface ReaperCliRenderWorkerOptions {
  readonly reaperExecutable: string;
  readonly workerScriptPath: string;
  readonly audioWorkRoot: string;
  readonly pollIntervalMs?: number;
  readonly launch?: (request: WorkerLaunchRequest) => Promise<void>;
}

function luaString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Modal REAPER dialogs (e.g. "REAPER New Version Notification", "About REAPER")
// swallow action 42230: the render "completes" but produces the plug-in noise
// floor. Close known nag windows best-effort before the render phase. Failures
// (no Accessibility permission, no such window) must never block a render.
const closeReaperNagWindowsScript = [
  'tell application "System Events"',
  '  tell process "REAPER"',
  '    repeat with w in windows',
  '      set n to name of w',
  '      if n contains "New Version Notification" or n starts with "About REAPER" then',
  "        try",
  '          click button 1 of w',
  "        end try",
  "      end if",
  "    end repeat",
  "  end tell",
  "end tell",
].join("\n");

async function closeReaperNagWindows(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFile("osascript", ["-e", closeReaperNagWindowsScript], { timeout: 10_000 });
  } catch { /* best-effort: nag window absence or AX denial must not block rendering */ }
}

// Silent-render guard. Every observed silent-render root cause (dead CoreAudio
// device, swallowed 42230, poisoned render path) converges on the same artifact:
// a full-length WAV whose peak is the plug-in noise floor. Verify the rendered
// file itself instead of trying to predict every failure mode.
async function assertRenderNotSilent(path: string): Promise<void> {
  const buffer = await readFile(path);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("render output is not a RIFF/WAVE file");
  }
  let audioFormat = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && chunkSize >= 16) {
      audioFormat = buffer.readUInt16LE(offset + 8);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
    }
    if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(chunkSize, buffer.length - dataOffset);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (dataOffset < 0 || dataLength <= 0) throw new Error("render output has no audio data chunk");
  const bytesPerSample = bitsPerSample / 8;
  if (bytesPerSample !== 2 && bytesPerSample !== 3 && bytesPerSample !== 4) {
    throw new Error(`render output has unsupported sample width: ${bitsPerSample}`);
  }
  const frameCount = Math.floor(dataLength / bytesPerSample);
  const stride = Math.max(1, Math.floor(frameCount / 500_000));
  let peak = 0;
  for (let frame = 0; frame < frameCount; frame += stride) {
    const at = dataOffset + frame * bytesPerSample;
    let value: number;
    if (audioFormat === 3 && bytesPerSample === 4) {
      value = Math.abs(buffer.readFloatLE(at));
    } else if (bytesPerSample === 2) {
      value = Math.abs(buffer.readInt16LE(at)) / 32768;
    } else if (bytesPerSample === 3) {
      const raw = buffer.readIntLE(at, 3);
      value = Math.abs(raw) / 8_388_608;
    } else {
      value = Math.abs(buffer.readInt32LE(at)) / 2_147_483_648;
    }
    if (value > peak) peak = value;
  }
  if (peak < 0.001) {
    throw new Error(
      `render output is silent (peak ${(20 * Math.log10(Math.max(peak, 1e-9))).toFixed(1)} dBFS); `
      + "audio engine or render path is poisoned, restart REAPER and retry",
    );
  }
}

export class ReaperCliRenderWorker implements ReaperRenderWorker {
  readonly #audioWorkRoot: string;
  readonly #pollIntervalMs: number;
  readonly #launch: (request: WorkerLaunchRequest) => Promise<void>;

  public constructor(private readonly options: ReaperCliRenderWorkerOptions) {
    this.#audioWorkRoot = resolve(options.audioWorkRoot);
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
    this.#launch = options.launch ?? (async ({ wrapperPath }) => {
      // Fire-and-forget: when REAPER is invoked through an app-alias path, the
      // launcher process hands the script to the running instance but may never
      // exit. Success is decided by the completion file poll, not process exit.
      await new Promise<void>((resolveLaunch, rejectLaunch) => {
        const child = spawn(options.reaperExecutable, ["-nonewinst", "-noactivate", wrapperPath], {
          stdio: "ignore",
          timeout: 5_000,
        });
        let settled = false;
        const graceTimer = setTimeout(() => {
          settled = true;
          resolveLaunch();
        }, 1_500);
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          rejectLaunch(error);
        });
        child.once("exit", () => {
          if (settled) return;
          settled = true;
          clearTimeout(graceTimer);
          resolveLaunch();
        });
        child.unref();
      });
    });
  }

  public async render(request: ReaperRenderRequest): Promise<void> {
    if (!isAbsolute(request.outputPath)) throw new Error("render worker output path must be absolute");
    const outputPath = resolve(request.outputPath);
    const outputRelative = relative(this.#audioWorkRoot, outputPath);
    if (outputRelative === "" || outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
      throw new Error("render worker output path must stay inside audio work root");
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      throw new Error("render worker timeout must be a positive integer");
    }
    if (!Number.isFinite(request.tailSeconds) || request.tailSeconds < 0 || request.tailSeconds > 10) {
      throw new Error("render worker tail must be between 0 and 10 seconds");
    }

    const directory = dirname(outputPath);
    await mkdir(directory, { recursive: true });
    const id = randomUUID();
    const deadline = Date.now() + request.timeoutMs;
    const warmupWrapperPath = `${outputPath}.${id}.warmup.lua`;
    const warmupCompletionPath = `${outputPath}.${id}.warmup-result`;
    const wrapperPath = `${outputPath}.${id}.worker.lua`;
    const completionPath = `${outputPath}.${id}.worker-result`;
    const warmupWrapper = [
      `local expected_project_id = ${luaString(request.expectedProjectId)}`,
      `local completion_path = ${luaString(warmupCompletionPath)}`,
      "local function complete(status, detail)",
      "  local completion = assert(io.open(completion_path, \"wb\"))",
      "  completion:write(status, \"\\n\", detail or \"\")",
      "  completion:close()",
      "end",
      "local project, project_path = reaper.EnumProjects(-1, \"\")",
      "if project_path ~= expected_project_id then complete(\"failed\", \"warmup project precondition failed\") return end",
      "local master = reaper.GetMasterTrack(project)",
      "local previous_volume = reaper.GetMediaTrackInfo_Value(master, \"D_VOL\")",
      "local previous_cursor = reaper.GetCursorPositionEx(project)",
      "local restored = false",
      "local function restore()",
      "  if restored then return end",
      "  restored = true",
      "  reaper.OnStopButton()",
      "  reaper.SetMediaTrackInfo_Value(master, \"D_VOL\", previous_volume)",
      "  reaper.SetEditCurPos2(project, previous_cursor, false, false)",
      "  reaper.UpdateArrange()",
      "end",
      "reaper.atexit(restore)",
      "if reaper.GetPlayState() ~= 0 then reaper.OnStopButton() end",
      "reaper.Audio_Quit()",
      "reaper.Audio_Init()",
      "if reaper.GetNumAudioOutputs() <= 0 then complete(\"failed\", \"warmup audio engine has no output channels\") return end",
      "reaper.SetMediaTrackInfo_Value(master, \"D_VOL\", 0)",
      "reaper.SetEditCurPos2(project, math.max(0, reaper.GetProjectLength(project) * 0.5), false, false)",
      "reaper.OnPlayButton()",
      "local started = reaper.time_precise()",
      "local peak = 0",
      "local function tick()",
      "  for index = 0, reaper.CountTracks(project) - 1 do",
      "    local track = reaper.GetTrack(project, index)",
      "    peak = math.max(peak, reaper.Track_GetPeakInfo(track, 0), reaper.Track_GetPeakInfo(track, 1))",
      "  end",
      "  if reaper.time_precise() - started < 4 then reaper.defer(tick) return end",
      "  restore()",
      "  if peak <= 0.000001 then complete(\"failed\", \"warmup produced no track signal\") else complete(\"succeeded\") end",
      "end",
      "reaper.defer(tick)",
      "",
    ].join("\n");
    const wrapper = [
      `local worker = assert(dofile(${luaString(this.options.workerScriptPath)}))`,
      "local ok, result = xpcall(function()",
      "  return worker({",
      `    expectedProjectId = ${luaString(request.expectedProjectId)},`,
      `    outputPath = ${luaString(outputPath)},`,
      `    tailSeconds = ${request.tailSeconds},`,
      "  })",
      "end, debug.traceback)",
      `local completion = assert(io.open(${luaString(completionPath)}, "wb"))`,
      "if ok then completion:write(\"succeeded\\n\") else completion:write(\"failed\\n\", tostring(result)) end",
      "completion:close()",
      "",
    ].join("\n");
    await writeFile(warmupWrapperPath, warmupWrapper, { encoding: "utf8", flag: "wx" });
    await writeFile(wrapperPath, wrapper, { encoding: "utf8", flag: "wx" });

    try {
      await this.#launch({
        phase: "warmup",
        wrapperPath: warmupWrapperPath,
        completionPath: warmupCompletionPath,
        outputPath,
      });
      await this.#waitForCompletion(warmupCompletionPath, deadline, "warmup");
      await closeReaperNagWindows();
      await this.#launch({ phase: "render", wrapperPath, completionPath, outputPath });
      await this.#waitForCompletion(completionPath, deadline, "render");
      const rendered = await stat(outputPath);
      if (!rendered.isFile() || rendered.size === 0) throw new Error("REAPER render worker output is empty");
      await assertRenderNotSilent(outputPath);
    } finally {
      await Promise.all([
        unlink(warmupWrapperPath).catch(() => undefined),
        unlink(warmupCompletionPath).catch(() => undefined),
        unlink(wrapperPath).catch(() => undefined),
        unlink(completionPath).catch(() => undefined),
      ]);
    }
  }

  async #waitForCompletion(completionPath: string, deadline: number, phase: string): Promise<void> {
    for (;;) {
      try {
        const completion = await readFile(completionPath, "utf8");
        const [status, ...details] = completion.split("\n");
        if (status !== "succeeded") throw new Error(details.join("\n") || `REAPER ${phase} worker failed`);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new Error(`REAPER ${phase} worker timed out`);
      await delay(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function renderPayload(payload: JsonValue): {
  readonly outputPath: string;
  readonly tailSeconds: number;
} {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("render.create payload must be an object");
  }
  if (typeof payload.outputPath !== "string"
    || payload.sampleRate !== 48_000
    || payload.channels !== 2
    || payload.format !== "wav"
    || typeof payload.tailSeconds !== "number") {
    throw new Error("render.create payload is invalid");
  }
  return { outputPath: payload.outputPath, tailSeconds: payload.tailSeconds };
}

export class ExternalRenderBridgeRequester implements BridgeRequester {
  public constructor(
    private readonly delegate: BridgeRequester,
    private readonly worker: ReaperRenderWorker,
  ) {}

  public async request(request: BridgeRequest): Promise<BridgeReceipt> {
    if (request.operation !== "render.create") return this.delegate.request(request);
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      if (!request.expectedProjectId) throw new Error("render.create requires an expected project id");
      const payload = renderPayload(request.payload);
      await this.worker.render({
        expectedProjectId: request.expectedProjectId,
        outputPath: payload.outputPath,
        tailSeconds: payload.tailSeconds,
        timeoutMs: request.timeoutMs,
      });
      return {
        schema: "rma.bridge-receipt/v1",
        protocol_version: 1,
        command_id: commandId,
        status: "succeeded",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        artifacts: [],
        warnings: [],
        error: null,
        result: { path: payload.outputPath, sampleRate: 48_000, channels: 2, format: "wav" },
      };
    } catch (error) {
      return {
        schema: "rma.bridge-receipt/v1",
        protocol_version: 1,
        command_id: commandId,
        status: "failed",
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        artifacts: [],
        warnings: [],
        error: { code: "RMA_RENDER_WORKER_FAILED", message: errorMessage(error) },
      };
    }
  }
}
