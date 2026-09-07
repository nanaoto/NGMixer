import assert from "node:assert/strict";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";

import {
  apply,
  createMixingKnowledgeTool,
  createOperatorMixTool,
  createOperatorRenderTool,
  createReloadableMixingRuntime,
  createMixingStatusTool,
  inject,
  MixingPluginReloadingError,
  mixingPluginReloadingCode,
  name,
  type MixingStatus,
} from "../src/dsh/mixing-plugin.js";
import type {
  MixingPreviewRequest,
  MixingRuntime,
  MixingRuntimeRequest,
} from "../src/mixing/runtime.js";

const expectedStatus: MixingStatus = {
  schema: "rma.session-view/v1",
  bridge: {
    instance_id: "main",
    heartbeat: {
      schema: "rma.bridge-heartbeat/v1",
      bridge_instance_id: "main",
      protocol_version: 1,
      observed_at: "2026-08-19T04:22:46Z",
      reaper_version: "7.73/macOS-arm64",
      project_id: "unsaved:main",
      project_change_count: 5,
      state: "idle",
      active_command_id: null,
    },
    health: { state: "idle", reaper_version: "7.73/macOS-arm64" },
  },
  project: { project_id: "unsaved:main", track_count: 3, tracks: [] },
};

test("mixing_status exposes one high-level read-only SessionView", async () => {
  const tool = createMixingStatusTool(async () => expectedStatus);
  const controller = new AbortController();

  const result = await tool.execute(
    {},
    { signal: controller.signal } as ToolRunContext,
  );

  assert.equal(tool.name, "mixing_status");
  assert.deepEqual(result, expectedStatus);
  assert.equal(tool.isConcurrencySafe?.({}), true);
});

test("mixing_knowledge searches the same versioned document library used by planning", async () => {
  const expected = {
    schema: "rma.mixing-knowledge/v2" as const,
    id: "library-test",
    version: "2.0.0",
    sha256: "a".repeat(64),
    documents: [{ id: "vocals", sha256: "b".repeat(64) }],
    query: "主唱齿音",
    hits: [{
      id: "vocals",
      title: "人声",
      score: 10,
      kind: "operational" as const,
      sha256: "b".repeat(64),
      content: "listen, diagnose, then process",
    }],
  };
  const requests: unknown[] = [];
  const tool = createMixingKnowledgeTool({
    search: async (request) => {
      requests.push(request);
      return expected;
    },
  });

  assert.equal(tool.name, "mixing_knowledge");
  assert.deepEqual(await tool.execute({ query: "主唱齿音", limit: 4 }, {} as ToolRunContext), expected);
  assert.deepEqual(requests, [{ query: "主唱齿音", limit: 4 }]);
  assert.equal(tool.isConcurrencySafe?.({ query: "主唱齿音", limit: 4 }), true);
});

test("global mix_audio lets any DSH agent invoke the one authoritative mixing runtime", async () => {
  let request: MixingRuntimeRequest | undefined;
  const runtime: MixingRuntime = {
    run: async (input) => {
      request = input;
      return {
        iteration: 2,
        plan: {
          schema: "rma.mix-plan/v2",
          sourceEventId: input.sourceEventId,
          sourceText: input.text,
          summary: "主唱靠前",
          actions: [{
            type: "track.gain.delta",
            track: { guid: "{TRACK-1}", name: "LEAD VOCAL" },
            deltaDb: 1,
            reason: "提高可懂度",
          }],
        },
        adjustments: [{
          actionIndex: 0,
          track: "LEAD VOCAL",
          plugin: "REAPER track control",
          parameter: "volumeDb",
          before: 0,
          after: 1,
          reason: "提高可懂度",
        }],
        artifact: {
          schema: "rma.artifact-ref/v1",
          artifactId: `artifact:${"a".repeat(64)}`,
          kind: "audio",
          availability: "available",
          fileName: "demo.mp3",
        },
        rendered: {
          projectId: "project-1",
          path: "/audio/demo.wav",
          fileName: "demo.wav",
          sampleRate: 48_000,
          channels: 2,
          format: "wav",
          bytes: 16,
          sha256: "b".repeat(64),
          renderBounds: "entire-project",
          tailSeconds: 2,
        },
      };
    },
    recordDelivery: async () => undefined,
  };
  const tool = createOperatorMixTool(runtime);
  const controller = new AbortController();

  const result = await tool.execute({ feedback: "把主唱推前" }, {
    signal: controller.signal,
    agent: { id: "headless-agent" },
  } as unknown as ToolRunContext) as {
    readonly plan: { readonly summary: string };
    readonly adjustments: readonly unknown[];
  };

  assert.equal(tool.name, "mix_audio");
  assert.match(request?.sessionId ?? "", /^dsh-mix-[a-f0-9]{32}$/u);
  assert.equal(request?.text, "把主唱推前");
  assert.equal(request?.deliveryFormat, "mp3");
  assert.deepEqual(request?.actor, { platform: "operator", id: "headless-agent" });
  assert.equal(result.plan.summary, "主唱靠前");
  assert.equal(result.adjustments.length, 1);
});

test("global render_demo exports the current project through the render-only runtime path", async () => {
  let request: MixingPreviewRequest | undefined;
  const tool = createOperatorRenderTool({
    run: async () => { throw new Error("render_demo must not run the mixing pipeline"); },
    renderPreview: async (input) => {
      request = input;
      return {
        iteration: 3,
        artifact: {
          schema: "rma.artifact-ref/v1",
          artifactId: `artifact:${"a".repeat(64)}`,
          kind: "audio",
          availability: "available",
          fileName: "demo.mp3",
        },
        rendered: {
          projectId: "project-current",
          path: "/audio/demo.wav",
          fileName: "demo.wav",
          sampleRate: 48_000,
          channels: 2,
          format: "wav",
          bytes: 16,
          sha256: "b".repeat(64),
          renderBounds: "entire-project",
          tailSeconds: 2,
        },
      };
    },
    recordDelivery: async () => undefined,
  });

  const result = await tool.execute({}, {
    signal: new AbortController().signal,
    agent: { id: "headless-agent" },
  } as unknown as ToolRunContext) as { artifact: { artifactId: string } };

  assert.equal(tool.name, "render_demo");
  assert.match(request?.sessionId ?? "", /^dsh-mix-[a-f0-9]{32}$/u);
  assert.equal(request?.deliveryFormat, "mp3");
  assert.equal(result.artifact.artifactId, `artifact:${"a".repeat(64)}`);
});

test("rapid plugin generations cannot bypass the original runtime drain", async (context) => {
  let resolveFirstStarted: () => void = () => undefined;
  let resolveFinishFirst: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => { resolveFirstStarted = resolve; });
  const finishFirst = new Promise<void>((resolve) => { resolveFinishFirst = resolve; });
  let thirdStarted = false;
  const first = createReloadableMixingRuntime(async () => ({
    run: async () => { throw new Error("not used"); },
    recordDelivery: async () => {
      resolveFirstStarted();
      await finishFirst;
    },
  }));
  let second: ReturnType<typeof createReloadableMixingRuntime> | undefined;
  let third: ReturnType<typeof createReloadableMixingRuntime> | undefined;
  context.after(async () => {
    resolveFinishFirst();
    await Promise.allSettled([first.drain(), second?.drain(), third?.drain()]);
  });
  const delivery = {
    sessionId: "reload-contract",
    sourceEventId: "source-1",
    iteration: 1,
    deliveryId: "delivery-1",
    status: "delivered" as const,
  };

  const firstOperation = first.recordDelivery(delivery);
  await firstStarted;
  second = createReloadableMixingRuntime(async () => ({
    run: async () => { throw new Error("not used"); },
    recordDelivery: async () => { throw new Error("idle generation must not run"); },
  }));
  third = createReloadableMixingRuntime(async () => ({
    run: async () => { throw new Error("not used"); },
    recordDelivery: async () => { thirdStarted = true; },
  }));
  const thirdOperation = third.recordDelivery(delivery);
  const firstDrain = first.drain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(thirdStarted, false);

  resolveFinishFirst();
  await Promise.all([firstOperation, firstDrain, second.drain(), thirdOperation]);
  assert.equal(thirdStarted, true);
  await assert.rejects(first.recordDelivery(delivery), (error: unknown) =>
    error instanceof MixingPluginReloadingError && error.code === mixingPluginReloadingCode);
});

test("Cordis plugin registers global status and operator mix tools and exposes a reload drain disposer", async () => {
  const registered: ToolDefinition[] = [];
  const provided: string[] = [];
  const context = {
    llm: { stream: () => { throw new Error("not called during plugin apply"); } },
    tools: { register: (definition: ToolDefinition) => registered.push(definition) },
    get: () => ({ currentSelection: () => ({ provider: "web-provider", model: "web-model" }) }),
    provide: (key: string) => { provided.push(key); },
  } as unknown as Context;

  const dispose = apply(context, {
    configPath: "/tmp/local.toml",
    bridgeInstanceId: "main",
    plannerProvider: "mix-planner",
    plannerModel: "planner-model",
  });

  assert.equal(name, "reaper-mixing-agent");
  assert.deepEqual(inject, ["tools", "llm", "agentDefaultModel"]);
  assert.deepEqual(registered.map((definition) => definition.name), [
    "mixing_status",
    "mixing_knowledge",
    "mix_audio",
    "render_demo",
    "list_materials",
    "rebuild_project",
  ]);
  assert.deepEqual(provided, ["mixingRuntime", "projectManager", "materialLibrary"]);
  assert.equal(typeof dispose, "function");
  await dispose();
});
