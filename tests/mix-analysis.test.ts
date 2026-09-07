import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeReceipt } from "../src/bridge/protocol.js";
import { ReaperMixAnalyzer } from "../src/mixing/analysis.js";
import type { BridgeRequest, BridgeRequester } from "../src/mixing/reaper-mix-engine.js";

function receipt(result: unknown): BridgeReceipt {
  return {
    schema: "rma.bridge-receipt/v1",
    protocol_version: 1,
    command_id: "11111111-1111-4111-8111-111111111111",
    status: "succeeded",
    started_at: "2026-08-21T00:00:00.000Z",
    finished_at: "2026-08-21T00:00:01.000Z",
    artifacts: [],
    warnings: [],
    error: null,
    result,
  };
}

function analysisResult(hasSignal = true): Record<string, unknown> {
  return {
    schema: "rma.mix-analysis/v1",
    projectId: "project-1",
    projectChangeCount: 7,
    analyzedAt: "2026-08-21T00:00:01.000Z",
    tracks: [{
      trackGuid: "{TRACK-1}",
      name: "LEAD VOCAL",
      index: 0,
      mediaItemCount: 1,
      mainSend: true,
      fx: [],
      sends: [],
      hasSignal,
      peakDb: hasSignal ? -3 : -150,
      rmsMomentaryDb: hasSignal ? -15 : -150,
      rmsIntegratedDb: hasSignal ? -16 : -150,
      lufsMomentary: hasSignal ? -14 : -150,
      lufsShortTerm: hasSignal ? -15 : -150,
      lufsIntegrated: hasSignal ? -16 : -150,
      loudnessRangeDb: hasSignal ? 5 : 0,
    }],
  };
}

function fakeRequester(
  requests: BridgeRequest[],
  baselinePaths: string[],
  hasSignal = true,
): BridgeRequester {
  return {
    request: async (request) => {
      requests.push(request);
      if (request.operation === "project.snapshot") return receipt({ project_id: "project-1" });
      assert.equal(request.operation, "analysis.capture");
      assert.equal(request.expectedProjectId, "project-1");
      assert.ok(typeof request.payload === "object" && request.payload !== null && !Array.isArray(request.payload));
      assert.equal(request.payload.format, "wav");
      const outputPath = String(request.payload.outputPath);
      baselinePaths.push(outputPath);
      await writeFile(outputPath, "measured baseline");
      return receipt(analysisResult(hasSignal));
    },
  };
}

test("ReaperMixAnalyzer renders and reads meters before deleting its temporary baseline", async () => {
  const audioWorkRoot = await mkdtemp(join(tmpdir(), "rma-analysis-"));
  const requests: BridgeRequest[] = [];
  const baselinePaths: string[] = [];
  const analyzer = new ReaperMixAnalyzer({
    requester: fakeRequester(requests, baselinePaths),
    audioWorkRoot,
  });

  const result = await analyzer.capture({
    sessionId: "qq-session-1",
    iteration: 2,
    signal: new AbortController().signal,
  });

  assert.deepEqual(requests.map((request) => request.operation), ["project.snapshot", "analysis.capture"]);
  assert.equal(result.schema, "rma.mix-analysis/v1");
  assert.equal(result.tracks[0]?.lufsIntegrated, -16);
  assert.match(baselinePaths[0] ?? "", /qq-session-1\/analysis\/iteration-0002-/u);
  await assert.rejects(access(baselinePaths[0] ?? ""), /ENOENT/u);
});

test("ReaperMixAnalyzer fails closed when the full render contains no measurable signal", async () => {
  const audioWorkRoot = await mkdtemp(join(tmpdir(), "rma-analysis-silent-"));
  const requests: BridgeRequest[] = [];
  const baselinePaths: string[] = [];
  const analyzer = new ReaperMixAnalyzer({
    requester: fakeRequester(requests, baselinePaths, false),
    audioWorkRoot,
  });

  await assert.rejects(analyzer.capture({
    sessionId: "qq-session-silent",
    iteration: 1,
    signal: new AbortController().signal,
  }), /RMA_ANALYSIS_REQUIRED/u);
  await assert.rejects(access(baselinePaths[0] ?? ""), /ENOENT/u);
});
