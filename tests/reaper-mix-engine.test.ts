import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";

import type { BridgeReceipt } from "../src/bridge/protocol.js";
import { ReaperMixEngine, type BridgeRequest, type BridgeRequester } from "../src/mixing/reaper-mix-engine.js";

test("REAPER engine executes a validated plan then renders into its assigned artifact root", async () => {
  const audioRoot = await mkdtemp(join(tmpdir(), "rma-render-root-"));
  const requests: BridgeRequest[] = [];
  const requester: BridgeRequester = {
    request: async (request) => {
      requests.push(request);
      if (request.operation === "project.snapshot") return receipt({ project_id: "project-1", project_change_count: 7 });
      if (request.operation === "transaction.execute") {
        return receipt({
          projectId: "project-1",
          adjustments: [{
            actionIndex: 0,
            track: "LEAD VOCAL",
            plugin: "REAPER track control",
            parameter: "volumeDb",
            before: -3,
            after: -1.5,
            reason: "主唱靠前",
          }],
        });
      }
      const outputPath = (request.payload as { outputPath: string }).outputPath;
      await writeFile(outputPath, "fake-wave-data");
      return receipt({ path: outputPath, sampleRate: 48_000, channels: 2, format: "wav" });
    },
  };
  const engine = new ReaperMixEngine({ requester, audioWorkRoot: audioRoot });
  const recorded: string[] = [];

  const result = await engine.run({
    sessionId: "session-1",
    iteration: 2,
    plan: {
      schema: "rma.mix-plan/v2",
      sourceEventId: "qq-100",
      sourceText: "主唱靠前一点 /tmp/escape.wav",
      summary: "主唱靠前",
      actions: [{ type: "track.gain.delta", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, deltaDb: 1.5, reason: "主唱靠前" }],
    },
    recordAdjustments: async (_adjustments, phase) => { recorded.push(phase); },
  });

  assert.deepEqual(requests.map((request) => request.operation), ["project.snapshot", "transaction.execute", "render.create"]);
  assert.equal(requests[1]?.expectedProjectId, "project-1");
  assert.equal(isAbsolute(result.artifact.path), true);
  assert.equal(relative(audioRoot, result.artifact.path).startsWith(".."), false);
  assert.equal(result.artifact.path.includes("escape.wav"), false);
  assert.equal(result.artifact.bytes, 14);
  assert.equal(result.artifact.projectId, "project-1");
  assert.equal(result.artifact.sha256, createHash("sha256").update("fake-wave-data").digest("hex"));
  assert.deepEqual(recorded, ["applied"]);
});

test("REAPER engine can render the current project without executing a mix transaction", async () => {
  const audioRoot = await mkdtemp(join(tmpdir(), "rma-render-only-"));
  const requests: BridgeRequest[] = [];
  const engine = new ReaperMixEngine({
    audioWorkRoot: audioRoot,
    requester: {
      request: async (request) => {
        requests.push(request);
        if (request.operation === "project.snapshot") return receipt({ project_id: "project-current", project_change_count: 3 });
        const outputPath = (request.payload as { outputPath: string }).outputPath;
        await writeFile(outputPath, "current-project-wave");
        return receipt({ path: outputPath, sampleRate: 48_000, channels: 2, format: "wav" });
      },
    },
  });

  const rendered = await engine.render({ sessionId: "session-1", iteration: 3 });

  assert.deepEqual(requests.map((request) => request.operation), ["project.snapshot", "render.create"]);
  assert.equal(requests[1]?.expectedProjectId, "project-current");
  assert.equal(rendered.projectId, "project-current");
  assert.equal(rendered.bytes, 20);
});

test("REAPER engine records the applied transaction and compensates it when render fails", async () => {
  const audioRoot = await mkdtemp(join(tmpdir(), "rma-render-rollback-"));
  const operations: string[] = [];
  const phases: string[] = [];
  const transactionDeltas: number[] = [];
  let transactionCount = 0;
  const engine = new ReaperMixEngine({
    audioWorkRoot: audioRoot,
    requester: {
      request: async (request) => {
        operations.push(request.operation);
        if (request.operation === "project.snapshot") return receipt({ project_id: "project-1", project_change_count: 7 });
        if (request.operation === "render.create") {
          return { ...receipt(undefined), status: "failed", error: { message: "render crashed" } };
        }
        transactionCount += 1;
        const delta = ((request.payload as { actions: Array<{ deltaDb: number }> }).actions[0]?.deltaDb) ?? 0;
        transactionDeltas.push(delta);
        return receipt({
          projectId: "project-1",
          adjustments: [{
            actionIndex: 0, track: "LEAD VOCAL", plugin: "REAPER track control", parameter: "volumeDb",
            before: transactionCount === 1 ? 11.5 : 12,
            after: transactionCount === 1 ? 12 : 11.5,
            reason: delta > 0 ? "主唱靠前" : "Rollback: 主唱靠前",
          }],
        });
      },
    },
  });

  await assert.rejects(engine.run({
    sessionId: "session-1",
    iteration: 1,
    plan: {
      schema: "rma.mix-plan/v2",
      sourceEventId: "qq-1",
      sourceText: "主唱靠前",
      summary: "主唱靠前",
      actions: [{ type: "track.gain.delta", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, deltaDb: 1.5, reason: "主唱靠前" }],
    },
    recordAdjustments: async (_adjustments, phase) => { phases.push(phase); },
  }), /render crashed/);

  assert.deepEqual(operations, ["project.snapshot", "transaction.execute", "render.create", "transaction.execute"]);
  assert.deepEqual(phases, ["applied", "rollback"]);
  assert.deepEqual(transactionDeltas, [1.5, -0.5]);
});

function receipt(result: unknown): BridgeReceipt {
  return {
    schema: "rma.bridge-receipt/v1",
    protocol_version: 1,
    command_id: "0198bfda-ef7d-75b2-84ae-b5b7d54c1800",
    status: "succeeded",
    started_at: "2026-08-19T12:00:00Z",
    finished_at: "2026-08-19T12:00:01Z",
    artifacts: [],
    warnings: [],
    error: null,
    result,
  };
}
