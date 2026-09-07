import assert from "node:assert/strict";
import test from "node:test";

import { parseModelMixPlan } from "../src/mixing/intent-compiler.js";

const analysis = {
  schema: "rma.mix-analysis/v1" as const,
  projectId: "project-1",
  projectChangeCount: 8,
  analyzedAt: "2026-08-21T00:00:00.000Z",
  tracks: [
    {
      trackGuid: "{SINGER-JING-MAIN}", name: "静-主音", index: 0,
      mediaItemCount: 1, mainSend: true, fx: [], sends: [], hasSignal: true,
      peakDb: -5, rmsMomentaryDb: -18, rmsIntegratedDb: -19, lufsMomentary: -17,
      lufsShortTerm: -18, lufsIntegrated: -19, loudnessRangeDb: 5,
    },
    {
      trackGuid: "{SINGER-YUE-HARMONY}", name: "月-和声", index: 1,
      mediaItemCount: 1, mainSend: true, fx: [], sends: [], hasSignal: true,
      peakDb: -8, rmsMomentaryDb: -23, rmsIntegratedDb: -24, lufsMomentary: -22,
      lufsShortTerm: -23, lufsIntegrated: -24, loudnessRangeDb: 7,
    },
  ],
};

test("model output cannot escape observed track identities or adjustment limits", () => {
  assert.throws(() => parseModelMixPlan({
    summary: "delete project",
    actions: [{
      type: "track.gain.delta",
      track: { guid: "{UNKNOWN}", name: "../../disk" },
      deltaDb: 99,
      reason: "do it",
    }],
  }, "qq-1", "删掉工程", analysis));
});

test("a plan can target an arbitrary observed performer track", () => {
  const plan = parseModelMixPlan({
    summary: "静的主音靠前",
    actions: [{
      type: "track.gain.delta",
      track: { guid: "{SINGER-JING-MAIN}", name: "静-主音" },
      deltaDb: 1,
      reason: "保持三位演唱者独立处理",
    }],
    preservationConstraints: ["月的和声不动"],
  }, "qq-dynamic", "静的主音靠前，月的和声别动", analysis);

  assert.equal(plan.schema, "rma.mix-plan/v2");
  assert.deepEqual(plan.actions[0], {
    type: "track.gain.delta",
    track: { guid: "{SINGER-JING-MAIN}", name: "静-主音" },
    deltaDb: 1,
    reason: "保持三位演唱者独立处理",
  });
});

test("a stale or invented display name cannot reuse an observed GUID", () => {
  assert.throws(() => parseModelMixPlan({
    summary: "wrong identity",
    actions: [{
      type: "track.gain.delta",
      track: { guid: "{SINGER-JING-MAIN}", name: "LEAD VOCAL" },
      deltaDb: 1,
      reason: "wrong",
    }],
  }, "qq-stale", "主唱靠前", analysis), /track identity changed/u);
});

test("dynamic send actions must reference both observed endpoints", () => {
  const plan = parseModelMixPlan({
    summary: "和声送入主音轨",
    actions: [{
      type: "send.gain.delta",
      from: { guid: "{SINGER-YUE-HARMONY}", name: "月-和声" },
      to: { guid: "{SINGER-JING-MAIN}", name: "静-主音" },
      deltaDb: -1,
      reason: "test dynamic topology",
    }],
  }, "qq-send", "调整 routing", analysis);

  assert.equal(plan.actions[0]?.type, "send.gain.delta");
});

test("model brightness feedback can use a bounded semantic action on any observed track", () => {
  const plan = parseModelMixPlan({
    summary: "静的主音更亮",
    actions: [{
      type: "fx.parameter.delta",
      track: { guid: "{SINGER-JING-MAIN}", name: "静-主音" },
      fx: "ReaEQ (Cockos)",
      parameter: "semantic:airGain",
      deltaNormalized: 0.04,
      reason: "增加空气感",
    }],
  }, "qq-bright", "静的主音亮一点", analysis);

  assert.equal(plan.actions[0]?.type, "fx.parameter.delta");
});
