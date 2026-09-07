import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeRequester } from "../src/mixing/reaper-mix-engine.js";
import {
  ExternalRenderBridgeRequester,
  ReaperCliRenderWorker,
  type ReaperRenderWorker,
} from "../src/reaper/render-worker.js";

function makeWav(peak: number, frames = 2048): Buffer {
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    data.writeInt16LE(Math.round(Math.sin(i / 10) * peak * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test("one-shot Lua worker hard-reinitializes audio before invoking the project-scoped render action", async () => {
  const script = await readFile(new URL("../reaper/RenderWorker.lua", import.meta.url), "utf8");
  assert.match(script, /Audio_Quit\(\)[\s\S]*Audio_Init\(\)[\s\S]*Main_OnCommandEx\(42230, 0, project\)/u);
});

test("CLI render worker dispatches an isolated ReaScript and waits for its completion marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-cli-render-"));
  const outputPath = join(root, "session", "render.wav");
  let wrapper = "";
  const phases: string[] = [];
  const worker = new ReaperCliRenderWorker({
    audioWorkRoot: root,
    reaperExecutable: "/Applications/REAPER.app/Contents/MacOS/REAPER",
    workerScriptPath: join(root, "installed", "RenderWorker.lua"),
    pollIntervalMs: 1,
    launch: async (request) => {
      phases.push(request.phase);
      const source = await readFile(request.wrapperPath, "utf8");
      if (request.phase === "render") {
        wrapper = source;
        await writeFile(request.outputPath, makeWav(0.5));
      }
      await writeFile(request.completionPath, "succeeded\n", "utf8");
    },
  });

  await worker.render({
    expectedProjectId: "/Volumes/test/project.rpp",
    outputPath,
    tailSeconds: 2,
    timeoutMs: 1_000,
  });

  assert.match(wrapper, /RenderWorker\.lua/u);
  assert.match(wrapper, /\/Volumes\/test\/project\.rpp/u);
  assert.match(wrapper, /tailSeconds = 2/u);
  assert.deepEqual(phases, ["warmup", "render"]);
  assert.equal((await readFile(outputPath)).subarray(0, 4).toString("ascii"), "RIFF");
});

test("CLI render worker rejects a silent render artifact instead of accepting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-cli-render-silent-"));
  const outputPath = join(root, "session", "render.wav");
  const worker = new ReaperCliRenderWorker({
    audioWorkRoot: root,
    reaperExecutable: "/Applications/REAPER.app/Contents/MacOS/REAPER",
    workerScriptPath: join(root, "installed", "RenderWorker.lua"),
    pollIntervalMs: 1,
    launch: async (request) => {
      if (request.phase === "render") {
        await writeFile(request.outputPath, makeWav(0.00001));
      }
      await writeFile(request.completionPath, "succeeded\n", "utf8");
    },
  });

  await assert.rejects(worker.render({
    expectedProjectId: "/Volumes/test/project.rpp",
    outputPath,
    tailSeconds: 2,
    timeoutMs: 1_000,
  }), /render output is silent/u);
});

test("CLI render worker rejects a non-WAVE render artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-cli-render-garbage-"));
  const outputPath = join(root, "session", "render.wav");
  const worker = new ReaperCliRenderWorker({
    audioWorkRoot: root,
    reaperExecutable: "/Applications/REAPER.app/Contents/MacOS/REAPER",
    workerScriptPath: join(root, "installed", "RenderWorker.lua"),
    pollIntervalMs: 1,
    launch: async (request) => {
      if (request.phase === "render") {
        await writeFile(request.outputPath, "not-a-wave-file");
      }
      await writeFile(request.completionPath, "succeeded\n", "utf8");
    },
  });

  await assert.rejects(worker.render({
    expectedProjectId: "/Volumes/test/project.rpp",
    outputPath,
    tailSeconds: 2,
    timeoutMs: 1_000,
  }), /RIFF\/WAVE/u);
});

test("CLI render worker rejects output paths outside its audio root", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-cli-render-root-"));
  const worker = new ReaperCliRenderWorker({
    audioWorkRoot: root,
    reaperExecutable: "/Applications/REAPER.app/Contents/MacOS/REAPER",
    workerScriptPath: join(root, "RenderWorker.lua"),
  });

  await assert.rejects(worker.render({
    expectedProjectId: "/Volumes/test/project.rpp",
    outputPath: join(root, "..", "escape.wav"),
    tailSeconds: 0,
    timeoutMs: 1_000,
  }), /inside audio work root/u);
});

test("external render requester bypasses the deferred Lua bridge only for render.create", async () => {
  const delegated: string[] = [];
  const rendered: string[] = [];
  const delegate: BridgeRequester = {
    request: async (request) => {
      delegated.push(request.operation);
      return {
        schema: "rma.bridge-receipt/v1",
        protocol_version: 1,
        command_id: "11111111-1111-4111-8111-111111111111",
        status: "succeeded",
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        artifacts: [],
        warnings: [],
        error: null,
        result: { project_id: "project-1" },
      };
    },
  };
  const renderWorker: ReaperRenderWorker = {
    render: async (request) => { rendered.push(request.outputPath); },
  };
  const requester = new ExternalRenderBridgeRequester(delegate, renderWorker);

  await requester.request({ sessionId: "s", operation: "project.snapshot", payload: {}, timeoutMs: 1_000 });
  const receipt = await requester.request({
    sessionId: "s",
    operation: "render.create",
    expectedProjectId: "project-1",
    timeoutMs: 1_000,
    payload: {
      outputPath: "/Volumes/test/render.wav",
      sampleRate: 48_000,
      channels: 2,
      format: "wav",
      tailSeconds: 2,
    },
  });

  assert.deepEqual(delegated, ["project.snapshot"]);
  assert.deepEqual(rendered, ["/Volumes/test/render.wav"]);
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(receipt.result, {
    path: "/Volumes/test/render.wav",
    sampleRate: 48_000,
    channels: 2,
    format: "wav",
  });
});
