import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalArtifactStore } from "../src/communication/artifact-store.js";
import { EventLedger } from "../src/ledger/event-store.js";
import type { MixEngine } from "../src/mixing/execution.js";
import type { MixIntentPlanner } from "../src/mixing/intent-compiler.js";
import { LedgerMixingRuntime } from "../src/mixing/runtime.js";

const analysisSnapshot = {
  schema: "rma.mix-analysis/v1" as const,
  projectId: "project-1",
  projectChangeCount: 1,
  analyzedAt: "2026-08-21T00:00:00.000Z",
  tracks: [{
    trackGuid: "{TRACK-1}",
    name: "LEAD VOCAL",
    index: 0,
    mediaItemCount: 1,
    mainSend: true,
    fx: [],
    sends: [],
    hasSignal: true,
    peakDb: -3,
    rmsMomentaryDb: -15,
    rmsIntegratedDb: -16,
    lufsMomentary: -14,
    lufsShortTerm: -15,
    lufsIntegrated: -16,
    loudnessRangeDb: 5,
  }],
};

const analyzer = { capture: async () => analysisSnapshot };

test("LedgerMixingRuntime imports assigned material, applies a plan, and publishes a durable render artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-runtime-"));
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const source = join(root, "lead.wav");
  await writeFile(source, "lead material");
  const inputArtifact = await store.importFile({
    kind: "audio",
    filePath: source,
    fileName: "lead.wav",
  }, new AbortController().signal);
  const renderedPath = join(root, "render.wav");
  await writeFile(renderedPath, "rendered mix");
  const order: string[] = [];
  const publishedFormats: string[] = [];
  let projectionFailure: unknown;
  const planner: MixIntentPlanner = {
    plan: async (input) => {
      assert.equal(input.analysis?.schema, "rma.mix-analysis/v1");
      return {
        schema: "rma.mix-plan/v2",
        sourceEventId: input.sourceEventId,
        sourceText: input.text,
        summary: "主唱靠前",
        actions: [{
          type: "track.gain.delta",
          track: { guid: "{TRACK-1}", name: "LEAD VOCAL" },
          deltaDb: 1.5,
          reason: "主唱靠前",
        }],
      };
    },
  };
  const engine: MixEngine = {
    run: async (request) => {
      order.push("mix");
      await request.recordAdjustments([{
        actionIndex: 0,
        track: "LEAD VOCAL",
        plugin: "REAPER track control",
        parameter: "volumeDb",
        before: 0,
        after: 1.5,
        reason: "主唱靠前",
      }], "applied");
      return {
        adjustments: [],
        artifact: {
          projectId: "project-1",
          path: renderedPath,
          fileName: "demo.wav",
          sampleRate: 48_000,
          channels: 2,
          format: "wav",
          bytes: 12,
          sha256: "0".repeat(64),
          renderBounds: "entire-project",
          tailSeconds: 2,
        },
      };
    },
  };
  const ledger = new EventLedger(join(root, "events.jsonl"));
  const runtime = new LedgerMixingRuntime({
    planner,
    analyzer: { capture: async () => { order.push("analyze"); return analysisSnapshot; } },
    engine,
    artifactStore: store,
    publishDemo: async (render, format, signal) => {
      publishedFormats.push(format);
      return store.importFile({
        kind: "audio",
        filePath: render.path,
        fileName: format === "mp3" ? "demo.mp3" : render.fileName,
        mediaType: format === "mp3" ? "audio/mpeg" : "audio/wav",
      }, signal);
    },
    ledgerForSession: () => ledger,
    projectRegistry: {
      list: async () => [],
      find: async () => undefined,
      advanceVersion: async () => { throw new Error("registry projection unavailable"); },
    },
    onProjectionError: (error) => { projectionFailure = error; },
    importMedia: async (files) => {
      order.push(`import:${files[0]?.trackName}`);
      assert.equal(files[0]?.filePath.includes(inputArtifact.sha256 ?? "missing"), true);
    },
  });

  const result = await runtime.run({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-message-1",
    expectedDeliveryId: "delivery-1",
    deliveryFormat: "mp3",
    text: "用我刚发的人声做一版，主唱靠前",
    actor: { platform: "qq", id: "7" },
    inputArtifacts: [{ artifact: inputArtifact, trackName: "静-主音" }],
    signal: new AbortController().signal,
  });

  assert.deepEqual(order, ["import:静-主音", "analyze", "mix"]);
  assert.equal(result.iteration, 1);
  assert.equal(result.artifact.availability, "available");
  assert.equal(result.artifact.fileName, "demo.mp3");
  assert.equal(result.artifact.mediaType, "audio/mpeg");
  assert.deepEqual(publishedFormats, ["mp3"]);
  assert.match(String(projectionFailure), /registry projection unavailable/u);
  assert.equal((await ledger.readAll()).at(-1)?.kind, "communication.sent");

  const replay = await runtime.run({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-message-1",
    expectedDeliveryId: "delivery-1",
    deliveryFormat: "mp3",
    text: "用我刚发的人声做一版，主唱靠前",
    actor: { platform: "qq", id: "7" },
    inputArtifacts: [{ artifact: inputArtifact, trackName: "静-主音" }],
    signal: new AbortController().signal,
  });
  assert.deepEqual(order, ["import:静-主音", "analyze", "mix"]);
  assert.equal(replay.iteration, 1);
  assert.equal(replay.artifact.artifactId, result.artifact.artifactId);

  await assert.rejects(runtime.run({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-message-2",
    expectedDeliveryId: "delivery-2",
    deliveryFormat: "mp3",
    text: "再亮一点",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  }), /RMA_SESSION_FROZEN.*delivery-1.*pending/u);
  await runtime.recordDelivery({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-message-1",
    iteration: 1,
    deliveryId: "delivery-1",
    status: "rejected",
    errorCode: "RMA_DELIVERY_REJECTED",
  });
  const second = await runtime.run({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-message-2",
    expectedDeliveryId: "delivery-2",
    deliveryFormat: "mp3",
    text: "再亮一点",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  });
  assert.equal(second.iteration, 2);
  assert.deepEqual(order, ["import:静-主音", "analyze", "mix", "analyze", "mix"]);
  assert.deepEqual(publishedFormats, ["mp3", "mp3"]);
});

test("LedgerMixingRuntime renders the accepted project without analyzing, planning, or mutating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-preview-runtime-"));
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const renderedPath = join(root, "current-project.wav");
  await writeFile(renderedPath, "rendered current project");
  const calls: string[] = [];
  const ledger = new EventLedger(join(root, "events.jsonl"));
  const rendered = {
    projectId: "project-current",
    path: renderedPath,
    fileName: "demo.wav",
    sampleRate: 48_000 as const,
    channels: 2 as const,
    format: "wav" as const,
    bytes: 24,
    sha256: "1".repeat(64),
    renderBounds: "entire-project" as const,
    tailSeconds: 2,
  };
  const runtime = new LedgerMixingRuntime({
    planner: { plan: async () => { calls.push("plan"); throw new Error("must not plan"); } },
    analyzer: { capture: async () => { calls.push("analyze"); return analysisSnapshot; } },
    engine: { run: async () => { calls.push("mix"); throw new Error("must not mix"); } },
    renderer: { render: async () => { calls.push("render"); return rendered; } },
    artifactStore: store,
    publishDemo: async (render, format, signal) => {
      calls.push(`publish:${format}`);
      return store.importFile({
        kind: "audio",
        filePath: render.path,
        fileName: "demo.mp3",
        mediaType: "audio/mpeg",
      }, signal);
    },
    ledgerForSession: () => ledger,
    importMedia: async () => { calls.push("import"); },
  });

  const result = await runtime.renderPreview({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-render-message-1",
    expectedDeliveryId: "qq-render-delivery-1",
    deliveryFormat: "mp3",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  });

  assert.deepEqual(calls, ["render", "publish:mp3"]);
  assert.equal(result.rendered.projectId, "project-current");
  assert.equal(result.artifact.mediaType, "audio/mpeg");
  assert.deepEqual((await ledger.readAll()).map((event) => event.kind), [
    "communication.received",
    "demo.render-completed",
    "demo.rendered",
    "communication.sent",
  ]);

  const recovered = await runtime.resumePending({
    sessionId: "qq-conversation-1",
    sourceEventId: "qq-render-message-1",
    expectedDeliveryId: "qq-render-delivery-1",
    signal: new AbortController().signal,
  });
  assert.equal(recovered?.result.artifact.artifactId, result.artifact.artifactId);
  assert.deepEqual(calls, ["render", "publish:mp3"]);
});

test("LedgerMixingRuntime rejects excess mutations before its bounded queue grows", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-runtime-backpressure-"));
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new LedgerMixingRuntime({
    maxPendingRuns: 1,
    analyzer,
    planner: {
      plan: async () => {
        started();
        await blocked;
        throw new Error("planned stop");
      },
    },
    engine: { run: async () => { throw new Error("engine must not run"); } },
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    ledgerForSession: () => new EventLedger(join(root, "events.jsonl")),
    importMedia: async () => undefined,
  });
  const first = runtime.run({
    sessionId: "bounded-session",
    sourceEventId: "message-1",
    text: "主唱靠前",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  });
  await startedPromise;
  await assert.rejects(runtime.run({
    sessionId: "bounded-session",
    sourceEventId: "message-2",
    text: "再亮一点",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  }), /RMA_MIXING_BACKPRESSURE/u);
  release();
  await assert.rejects(first, /planned stop/u);
});

test("LedgerMixingRuntime never plans or mutates when pre-mutation analysis fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-runtime-analysis-failure-"));
  const ledger = new EventLedger(join(root, "events.jsonl"));
  let plannerCalls = 0;
  let engineCalls = 0;
  const runtime = new LedgerMixingRuntime({
    analyzer: { capture: async () => { throw new Error("RMA_ANALYSIS_REQUIRED: meter unavailable"); } },
    planner: {
      plan: async () => {
        plannerCalls += 1;
        throw new Error("planner must not run");
      },
    },
    engine: {
      run: async () => {
        engineCalls += 1;
        throw new Error("engine must not run");
      },
    },
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    ledgerForSession: () => ledger,
    importMedia: async () => undefined,
  });

  await assert.rejects(runtime.run({
    sessionId: "analysis-failure",
    sourceEventId: "message-analysis-failure",
    text: "混一下",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  }), /RMA_ANALYSIS_REQUIRED/u);

  assert.equal(plannerCalls, 0);
  assert.equal(engineCalls, 0);
  const events = await ledger.readAll();
  assert.equal(events.some((event) => event.kind === "mix.plan-created"), false);
  assert.equal(events.at(-1)?.kind, "mix.iteration.failed");
});

test("LedgerMixingRuntime reports a disposed generation as an explicit cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-runtime-disposed-"));
  const ledger = new EventLedger(join(root, "events.jsonl"));
  const controller = new AbortController();
  const runtime = new LedgerMixingRuntime({
    analyzer: {
      capture: async () => {
        controller.abort({ kind: "disposed" });
        throw controller.signal.reason;
      },
    },
    planner: { plan: async () => { throw new Error("planner must not run"); } },
    engine: { run: async () => { throw new Error("engine must not run"); } },
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    ledgerForSession: () => ledger,
    importMedia: async () => undefined,
  });

  await assert.rejects(runtime.run({
    sessionId: "disposed-generation",
    sourceEventId: "message-disposed",
    text: "渲染一版",
    actor: { platform: "qq", id: "7" },
    signal: controller.signal,
  }), /RMA_MIXING_CANCELLED: plugin generation was disposed during mixing/u);

  const failed = (await ledger.readAll()).at(-1);
  assert.equal(failed?.kind, "mix.iteration.failed");
  assert.equal((failed?.payload as { errorCode?: string } | undefined)?.errorCode, "RMA_MIXING_CANCELLED");
});

test("LedgerMixingRuntime durably records a disposed request before execution starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-runtime-pre-disposed-"));
  const ledger = new EventLedger(join(root, "events.jsonl"));
  const controller = new AbortController();
  controller.abort({ kind: "disposed" });
  const runtime = new LedgerMixingRuntime({
    analyzer: { capture: async () => { throw new Error("analyzer must not run"); } },
    planner: { plan: async () => { throw new Error("planner must not run"); } },
    engine: { run: async () => { throw new Error("engine must not run"); } },
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    ledgerForSession: () => ledger,
    importMedia: async () => { throw new Error("import must not run"); },
  });

  await assert.rejects(runtime.run({
    sessionId: "pre-disposed-generation",
    sourceEventId: "message-pre-disposed",
    text: "渲染一版",
    actor: { platform: "qq", id: "7" },
    signal: controller.signal,
  }), /RMA_MIXING_CANCELLED: plugin generation was disposed during mixing/u);

  const events = await ledger.readAll();
  assert.deepEqual(events.map((event) => event.kind), ["communication.received", "mix.iteration.failed"]);
  assert.equal(
    (events.at(-1)?.payload as { errorCode?: string } | undefined)?.errorCode,
    "RMA_MIXING_CANCELLED",
  );
});

test("LedgerMixingRuntime resumes publication from durable WAV evidence without replanning or remutating", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-runtime-publish-recovery-"));
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const renderedPath = join(root, "demo.wav");
  await writeFile(renderedPath, "durable rendered wav");
  const ledger = new EventLedger(join(root, "events.jsonl"));
  let planCalls = 0;
  let engineCalls = 0;
  let publishCalls = 0;
  const plan = {
    schema: "rma.mix-plan/v2" as const,
    sourceEventId: "message-recover",
    sourceText: "主唱靠前",
    summary: "主唱靠前",
    actions: [{
      type: "track.gain.delta" as const,
      track: { guid: "{TRACK-1}", name: "LEAD VOCAL" } as const,
      deltaDb: 1,
      reason: "主唱靠前",
    }],
  };
  const rendered = {
    projectId: "project-1",
    path: renderedPath,
    fileName: "demo.wav",
    sampleRate: 48_000 as const,
    channels: 2 as const,
    format: "wav" as const,
    bytes: 20,
    sha256: "a".repeat(64),
    renderBounds: "entire-project" as const,
    tailSeconds: 2,
  };
  const failedPublisher = new LedgerMixingRuntime({
    analyzer,
    planner: {
      plan: async () => {
        planCalls += 1;
        return plan;
      },
    },
    engine: {
      run: async () => {
        engineCalls += 1;
        return { adjustments: [], artifact: rendered };
      },
    },
    artifactStore: store,
    publishDemo: async () => {
      publishCalls += 1;
      throw new Error("RMA_RENDER_FAILED: delivery audio publication failed");
    },
    ledgerForSession: () => ledger,
    importMedia: async () => undefined,
  });
  const request = {
    sessionId: "publish-recovery",
    sourceEventId: "message-recover",
    expectedDeliveryId: "delivery-recover",
    deliveryFormat: "mp3" as const,
    deliveryTarget: "default-group" as const,
    text: "主唱靠前",
    actor: { platform: "qq" as const, id: "7" },
    signal: new AbortController().signal,
  };

  await assert.rejects(failedPublisher.run(request), /RMA_RENDER_FAILED/u);
  const failedEvents = await ledger.readAll();
  assert.equal(planCalls, 1);
  assert.equal(engineCalls, 1);
  assert.equal(publishCalls, 1);
  assert.ok(failedEvents.some((event) => event.kind === "demo.render-completed"));
  assert.equal(failedEvents.some((event) => event.kind === "demo.rendered"), false);
  await assert.rejects(failedPublisher.run({
    ...request,
    sourceEventId: "message-after-failed-publication",
    expectedDeliveryId: "delivery-after-failed-publication",
    text: "再亮一点",
  }), /RMA_SESSION_FROZEN.*awaits delivery artifact publication/u);
  assert.equal(planCalls, 1);
  assert.equal(engineCalls, 1);

  const recoveredPublisher = new LedgerMixingRuntime({
    analyzer,
    planner: { plan: async () => { throw new Error("planner must not run during recovery"); } },
    engine: { run: async () => { throw new Error("engine must not run during recovery"); } },
    artifactStore: store,
    publishDemo: async (rawRender, format, signal) => {
      publishCalls += 1;
      assert.equal(rawRender.path, renderedPath);
      assert.equal(format, "mp3");
      return store.importFile({
        kind: "audio",
        filePath: rawRender.path,
        fileName: "demo.mp3",
        mediaType: "audio/mpeg",
      }, signal);
    },
    ledgerForSession: () => ledger,
    importMedia: async () => undefined,
  });
  const recovered = await recoveredPublisher.resumePending({
    sessionId: request.sessionId,
    sourceEventId: request.sourceEventId,
    expectedDeliveryId: request.expectedDeliveryId,
    signal: new AbortController().signal,
  });

  assert.equal(planCalls, 1);
  assert.equal(engineCalls, 1);
  assert.equal(publishCalls, 2);
  assert.equal(recovered?.deliveryFormat, "mp3");
  assert.equal(recovered?.deliveryTarget, "default-group");
  assert.equal(recovered?.result.artifact.mediaType, "audio/mpeg");
  const recoveredEvents = await ledger.readAll();
  assert.ok(recoveredEvents.some((event) => event.kind === "demo.rendered"));
  assert.ok(recoveredEvents.some((event) =>
    event.kind === "communication.sent"
    && (event.payload as { status?: string }).status === "pending"));
});

test("cancelled iteration releases the publication freeze", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-cancelled-freeze-"));
  const ledger = new EventLedger(join(root, "events.jsonl"));
  await ledger.append({
    eventId: "evt-render-orphan",
    sessionId: "cancelled-session",
    iteration: 31,
    kind: "demo.render-completed",
    actor: { platform: "reaper", id: "reaper" },
    training: { use: "unknown", contentClass: "audio-artifact" },
    payload: {
      sourceEventId: "qq:1:group:2:cancelled-message",
      deliveryFormat: "mp3",
      deliveryTarget: "source",
      renderMode: "current-project",
      render: {
        projectId: "/projects/x.rpp",
        path: "/audio/x.wav",
        fileName: "x.wav",
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        bytes: 1,
        sha256: "0".repeat(64),
        renderBounds: "entire-project",
        tailSeconds: 2,
      },
    },
  });
  await ledger.append({
    eventId: "evt-cancelled",
    sessionId: "cancelled-session",
    iteration: 31,
    kind: "mix.iteration.failed",
    actor: { platform: "agent", id: "mixing-agent" },
    training: { use: "unknown", contentClass: "audio-artifact" },
    payload: {
      sourceEventId: "qq:1:group:2:cancelled-message",
      errorCode: "RMA_MIXING_CANCELLED",
    },
  });
  const renderedPath = join(root, "render.wav");
  await writeFile(renderedPath, "rendered mix");
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const runtime = new LedgerMixingRuntime({
    analyzer: { capture: async () => analysisSnapshot },
    planner: { plan: async (input) => ({
      schema: "rma.mix-plan/v2",
      sourceEventId: input.sourceEventId,
      sourceText: input.text,
      summary: "noop",
      actions: [],
    }) },
    engine: { run: async () => ({
      adjustments: [],
      artifact: {
        projectId: "project-1",
        path: renderedPath,
        fileName: "demo.wav",
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        bytes: 12,
        sha256: "0".repeat(64),
        renderBounds: "entire-project",
        tailSeconds: 2,
      },
    }) },
    artifactStore: store,
    publishDemo: async (render, format, signal) => store.importFile({
      kind: "audio",
      filePath: render.path,
      fileName: format === "mp3" ? "demo.mp3" : render.fileName,
      mediaType: format === "mp3" ? "audio/mpeg" : "audio/wav",
    }, signal),
    ledgerForSession: () => ledger,
    importMedia: async () => undefined,
  });
  // Must not throw RMA_SESSION_FROZEN for the abandoned cancelled iteration.
  await runtime.run({
    sessionId: "cancelled-session",
    sourceEventId: "qq:1:private:3:new-message",
    text: "继续混音",
    actor: { platform: "qq", id: "3" },
    signal: new AbortController().signal,
  });
  const events = await ledger.readAll();
  assert.ok(events.some((event) => event.kind === "communication.received"
    && event.eventId === "qq:1:private:3:new-message"));
});

test("migrated project ledger version seeds the next render and named-project lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-project-version-"));
  const renderedPath = join(root, "render.wav");
  await writeFile(renderedPath, "version ninety");
  const ledger = new EventLedger(join(root, "events.jsonl"));
  const store = new LocalArtifactStore(join(root, "artifacts"));
  await ledger.append({
    eventId: "migrated-v089",
    sessionId: "project-session",
    iteration: 89,
    kind: "demo.rendered",
    actor: { platform: "operator", id: "migration" },
    payload: {
      sourceEventId: "migration:everytime:v089",
      artifact: {
        schema: "rma.artifact-ref/v1",
        artifactId: `artifact:${"9".repeat(64)}`,
        kind: "audio",
        availability: "available",
        fileName: "everytime-v089.mp3",
        sha256: "9".repeat(64),
      },
      render: {
        projectId: "/projects/everytime.rpp",
        path: "/audio/everytime-v089.wav",
        fileName: "everytime-v089.wav",
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        bytes: 1,
        sha256: "8".repeat(64),
        renderBounds: "entire-project",
        tailSeconds: 2,
      },
    },
    training: { use: "unknown", contentClass: "audio-artifact" },
  });
  let advancedTo: number | undefined;
  const registry = {
    list: async () => [{
      name: "everytime",
      sessionId: "project-session",
      projectPath: "/projects/everytime.rpp",
      currentVersion: advancedTo ?? 89,
      registeredAt: "2026-08-25T00:00:00.000Z",
    }],
    find: async (name: string) => name === "everytime" ? (await registry.list())[0] : undefined,
    advanceVersion: async (_sessionId: string, version: number) => { advancedTo = version; },
  };
  const runtime = new LedgerMixingRuntime({
    analyzer,
    planner: { plan: async () => { throw new Error("not used"); } },
    engine: { run: async () => { throw new Error("not used"); } },
    renderer: {
      render: async ({ iteration }) => ({
        projectId: "/projects/everytime.rpp",
        path: renderedPath,
        fileName: `everytime-v${String(iteration).padStart(3, "0")}.wav`,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        bytes: 14,
        sha256: "a".repeat(64),
        renderBounds: "entire-project",
        tailSeconds: 2,
      }),
    },
    artifactStore: store,
    publishDemo: async (render, _format, signal) => store.importFile({
      kind: "audio",
      filePath: render.path,
      fileName: render.fileName.replace(/\.wav$/u, ".mp3"),
      mediaType: "audio/mpeg",
    }, signal),
    ledgerForSession: () => ledger,
    projectRegistry: registry,
    importMedia: async () => undefined,
  });

  const rendered = await runtime.renderPreview({
    sessionId: "project-session",
    sourceEventId: "render-v090",
    actor: { platform: "qq", id: "7" },
    signal: new AbortController().signal,
  });

  assert.equal(rendered.iteration, 90);
  assert.equal(advancedTo, 90);
  assert.equal((await runtime.findProjectRendered("everytime"))?.artifact.fileName, "everytime-v090.mp3");
  await ledger.append({
    eventId: "late-recovery-v031",
    sessionId: "project-session",
    iteration: 31,
    kind: "demo.rendered",
    actor: { platform: "reaper", id: "reaper" },
    payload: {
      sourceEventId: "old-pending-source",
      artifact: rendered.artifact,
      render: { ...rendered.rendered, fileName: "everytime-v031.wav" },
    },
    training: { use: "unknown", contentClass: "audio-artifact" },
  });
  assert.equal(
    (await runtime.findProjectRendered("everytime"))?.artifact.fileName,
    "everytime-v090.mp3",
    "a late recovery of an older iteration must not become latest",
  );
});

test("QQ replies to a delivered project render are recorded against that exact artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-project-feedback-"));
  const ledger = new EventLedger(join(root, "events.jsonl"));
  const sessionId = "project-session";
  const artifact = {
    schema: "rma.artifact-ref/v1" as const,
    artifactId: `artifact:${"b".repeat(64)}`,
    kind: "audio" as const,
    availability: "available" as const,
    fileName: "everytime-v089.mp3",
    sha256: "b".repeat(64),
  };
  const render = {
    projectId: "/projects/everytime.rpp",
    path: "/audio/everytime-v089.wav",
    fileName: "everytime-v089.wav",
    sampleRate: 48_000 as const,
    channels: 2 as const,
    format: "wav" as const,
    bytes: 1,
    sha256: "a".repeat(64),
    renderBounds: "entire-project" as const,
    tailSeconds: 2,
  };
  await ledger.append({
    eventId: "rendered-89",
    sessionId,
    iteration: 89,
    kind: "demo.rendered",
    actor: { platform: "reaper", id: "reaper" },
    payload: { sourceEventId: "render-source", artifact, render },
    training: { use: "unknown", contentClass: "audio-artifact" },
  });
  await ledger.append({
    eventId: "alternate-rendered-89",
    sessionId,
    iteration: 89,
    kind: "demo.rendered",
    actor: { platform: "reaper", id: "reaper" },
    payload: {
      sourceEventId: "alternate-render-source",
      artifact: { ...artifact, artifactId: `artifact:${"c".repeat(64)}`, sha256: "c".repeat(64) },
      render: { ...render, sha256: "c".repeat(64) },
    },
    training: { use: "unknown", contentClass: "audio-artifact" },
  });
  await ledger.append({
    eventId: "delivered-89",
    sessionId,
    iteration: 89,
    kind: "communication.sent",
    actor: { platform: "agent", id: "qq-agent" },
    payload: {
      sourceEventId: "group-request",
      deliveryId: "delivery-89",
      status: "delivered",
      platformMessageId: "qq-file-message-89",
      artifactId: artifact.artifactId,
    },
    training: { use: "unknown", contentClass: "system-output" },
  });
  const registry = {
    list: async () => [{
      name: "everytime",
      sessionId,
      projectPath: "/projects/everytime.rpp",
      currentVersion: 89,
      registeredAt: "2026-08-25T00:00:00.000Z",
    }],
    find: async () => undefined,
    advanceVersion: async () => undefined,
  };
  const runtime = new LedgerMixingRuntime({
    analyzer,
    planner: { plan: async () => { throw new Error("not used"); } },
    engine: { run: async () => { throw new Error("not used"); } },
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    ledgerForSession: () => ledger,
    projectRegistry: registry,
    importMedia: async () => undefined,
  });

  const feedback = await runtime.recordProjectFeedback({
    platformMessageId: "qq-file-message-89",
    sourceEventId: "qq-feedback-1",
    messageId: "feedback-message-1",
    text: "主唱再近一点",
    actor: { platform: "qq", id: "listener", displayName: "Listener" },
  });

  assert.equal(feedback?.projectName, "everytime");
  assert.equal(feedback?.iteration, 89);
  const event = (await ledger.readAll()).find((candidate) => candidate.kind === "feedback.received");
  assert.deepEqual(event?.payload, {
    sourceEventId: "qq-feedback-1",
    messageId: "feedback-message-1",
    replyToPlatformMessageId: "qq-file-message-89",
    projectName: "everytime",
    artifactId: artifact.artifactId,
    text: "主唱再近一点",
  });
});
