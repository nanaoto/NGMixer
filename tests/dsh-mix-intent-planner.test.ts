import assert from "node:assert/strict";
import test from "node:test";

import { LlmError, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";

import type { CompileMixIntentInput } from "../src/mixing/intent-compiler.js";

import { DshMixIntentPlanner } from "../src/dsh/mix-intent-planner.js";

const testKnowledge = {
  async search() {
    return {
      schema: "rma.mixing-knowledge/v2" as const,
      id: "test-library",
      version: "2.0.0",
      sha256: "0123456789abcdef",
      documents: [{ id: "vocals", sha256: "fedcba9876543210" }],
      query: "vocal",
      hits: [{
        id: "vocals",
        title: "Vocals",
        score: 12,
        kind: "operational" as const,
        sha256: "fedcba9876543210",
        content: "Diagnose from evidence before choosing a processor.",
      }],
    };
  },
};

test("DSH mix planning selects its provider route through the shared LLM seam", async () => {
  const requests: GenerateOptions[] = [];
  const response = JSON.stringify({
    summary: "降低叠唱",
    actions: [{
      type: "track.gain.delta",
      track: { guid: "{TRACK-1}", name: "DOUBLES" },
      deltaDb: -1.5,
      reason: "给主唱让位",
    }],
    preservationConstraints: ["保持主唱不变"],
  });
  const llm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: response };
      yield { type: "block-end", index: 0, block: { type: "text", text: response } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const controller = new AbortController();
  let selectedModel = { provider: "mix-planner", model: "planner-model" };
  const planner = new DshMixIntentPlanner(llm, () => selectedModel, testKnowledge);

  const input: CompileMixIntentInput = {
    text: "再收一点",
    sourceEventId: "qq-2",
    analysis: {
      schema: "rma.mix-analysis/v1",
      projectId: "project-1",
      projectChangeCount: 7,
      analyzedAt: "2026-08-21T00:00:00.000Z",
      tracks: [{
        trackGuid: "{TRACK-1}",
        name: "DOUBLES",
        index: 0,
        mediaItemCount: 1,
        mainSend: true,
        fx: [],
        sends: [],
        hasSignal: true,
        peakDb: -6,
        rmsMomentaryDb: -20,
        rmsIntegratedDb: -21,
        lufsMomentary: -18,
        lufsShortTerm: -19,
        lufsIntegrated: -20,
        loudnessRangeDb: 6,
      }],
    },
    context: { previousIteration: 1, recentTurns: [{ kind: "mix.plan-created" }] },
    signal: controller.signal,
  };
  const plan = await planner.plan(input);

  assert.equal(requests[0]?.provider, "mix-planner");
  assert.equal(requests[0]?.model, "planner-model");
  // kimi-k3 的 coding 端点只接受 temperature=1 或不传；不传以获得确定性尽量高的默认行为
  assert.equal(requests[0]?.temperature, undefined);
  assert.equal(requests[0]?.signal, controller.signal);
  assert.match(requests[0]?.system ?? "", /project topology is dynamic/u);
  assert.match(requests[0]?.system ?? "", /GUID is the mutation identity/u);
  assert.match(requests[0]?.system ?? "", /Diagnose from evidence before choosing a processor/u);
  assert.match(requests[0]?.system ?? "", /Never ask the user to read meters/u);
  assert.match(requests[0]?.system ?? "", /id="test-library" version="2\.0\.0"/u);
  assert.match(requests[0]?.system ?? "", /documents="vocals"/u);
  assert.match(JSON.stringify(requests[0]?.messages), /previousIteration/u);
  assert.match(JSON.stringify(requests[0]?.messages), /rma\.mix-analysis\/v1/u);
  assert.equal(plan.sourceEventId, "qq-2");
  assert.deepEqual(plan.knowledgePack, {
    schema: "rma.mixing-knowledge/v2",
    id: "test-library",
    version: "2.0.0",
    sha256: "0123456789abcdef",
    documents: [{ id: "vocals", sha256: "fedcba9876543210" }],
  });
  assert.deepEqual(plan.actions, [
    {
      type: "track.gain.delta",
      track: { guid: "{TRACK-1}", name: "DOUBLES" },
      deltaDb: -1.5,
      reason: "给主唱让位",
    },
  ]);
  selectedModel = { provider: "another-provider", model: "another-model" };
  await planner.plan(input);
  assert.equal(requests[1]?.provider, "another-provider");
  assert.equal(requests[1]?.model, "another-model");

});

test("DSH mix planning discards a failed 403 attempt and retries the same model on its fallback route", async () => {
  const requests: GenerateOptions[] = [];
  const response = JSON.stringify({
    summary: "备用端点完成规划",
    actions: [{
      type: "track.gain.delta",
      track: { guid: "{TRACK-1}", name: "VOCAL" },
      deltaDb: -0.5,
      reason: "轻微收回",
    }],
    preservationConstraints: [],
  });
  const llm = {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options);
      if (options.provider === "primary") {
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: "discard-me" };
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: { code: "AUTH", message: "forbidden", status: 403 },
          },
        };
        return;
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: response };
      yield { type: "block-end", index: 0, block: { type: "text", text: response } };
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
  const planner = new DshMixIntentPlanner(llm, {
    provider: "primary",
    model: "same-model",
    fallbacks: [{ provider: "backup", model: "same-model" }],
  }, testKnowledge);

  const plan = await planner.plan({
    text: "再收一点",
    sourceEventId: "qq-failover",
    analysis: {
      schema: "rma.mix-analysis/v1",
      projectId: "project-1",
      projectChangeCount: 7,
      analyzedAt: "2026-08-24T00:00:00.000Z",
      tracks: [{
        trackGuid: "{TRACK-1}",
        name: "VOCAL",
        index: 0,
        mediaItemCount: 1,
        mainSend: true,
        fx: [],
        sends: [],
        hasSignal: true,
        peakDb: -6,
        rmsMomentaryDb: -20,
        rmsIntegratedDb: -21,
        lufsMomentary: -18,
        lufsShortTerm: -19,
        lufsIntegrated: -20,
        loudnessRangeDb: 6,
      }],
    },
  });

  assert.deepEqual(requests.map(({ provider, model }) => ({ provider, model })), [
    { provider: "primary", model: "same-model" },
    { provider: "backup", model: "same-model" },
  ]);
  assert.equal(plan.summary, "备用端点完成规划");
});

test("DSH mix planning preserves the final route's structured quota failure", async () => {
  const llm = {
    async *stream(): AsyncIterable<StreamChunk> {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: {
            code: "QUOTA",
            message: "monthly quota exhausted",
            status: 403,
            providerRetryAfterMs: 60_000,
          },
        },
      };
    },
  };
  const planner = new DshMixIntentPlanner(llm, {
    provider: "primary",
    model: "same-model",
    fallbacks: [{ provider: "backup", model: "same-model" }],
  }, testKnowledge);

  await assert.rejects(planner.plan({
    text: "主唱更亮",
    sourceEventId: "qq-quota-exhausted",
    analysis: {
      schema: "rma.mix-analysis/v1",
      projectId: "project-1",
      projectChangeCount: 7,
      analyzedAt: "2026-08-24T00:00:00.000Z",
      tracks: [],
    },
  }), (error: unknown) => {
    assert.ok(error instanceof LlmError);
    assert.deepEqual(error.failure, {
      code: "QUOTA",
      message: "monthly quota exhausted",
      status: 403,
      providerRetryAfterMs: 60_000,
    });
    return true;
  });
});
