import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";

import { readBridgeStatuses, type BridgeHeartbeat } from "../bridge/heartbeat.js";
import type { BridgeOperation, JsonValue } from "../bridge/protocol.js";
import { BridgeSpool } from "../bridge/spool.js";
import { LocalArtifactStore } from "../communication/artifact-store.js";
import { JsonlMaterialCatalog, type MaterialLibrary } from "../communication/material-catalog.js";
import { loadConfig, type LlmModelSelection, type LlmModelRoute } from "../config.js";
import { SerialMutationQueue, type MutationQueue } from "../host/mutation-queue.js";
import { EventLedger } from "../ledger/event-store.js";
import { installedFabFilterPlugins } from "../mcp/fabfilter-catalog.js";
import { ReaperMixAnalyzer } from "../mixing/analysis.js";
import {
  FileMixingKnowledgeLibrary,
  type MixingKnowledgeLibrary,
} from "../mixing/knowledge-pack.js";
import { FfmpegDemoPublisher } from "../mixing/demo-publisher.js";
import { FabFilterMixPolicy } from "../mixing/fabfilter-mix-policy.js";
import { ReaperMixEngine, SpoolBridgeRequester } from "../mixing/reaper-mix-engine.js";
import { JsonProjectRegistry } from "../mixing/project-registry.js";
import {
  LedgerMixingRuntime,
  type MixingPreviewRequest,
  type MixingPreviewResult,
  type MixingRuntime,
} from "../mixing/runtime.js";
import { ReaperProjectManager, type ProjectManager } from "../project/project-manager.js";
import { ExternalRenderBridgeRequester, ReaperCliRenderWorker } from "../reaper/render-worker.js";
import { DshMixIntentPlanner, type RoutedLlm } from "./mix-intent-planner.js";
import { createMaterialLibraryTool, createProjectRebuildTool } from "./project-tools.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    mixingRuntime: MixingRuntime;
    projectManager: ProjectManager;
    materialLibrary: MaterialLibrary;
  }
}

export const name = "reaper-mixing-agent";
export const inject = ["tools", "llm", "agentDefaultModel"] as const;

export interface MixingPluginConfig {
  readonly configPath: string;
  readonly bridgeInstanceId: string;
  readonly plannerProvider?: string;
  readonly plannerModel?: string;
  readonly plannerFallbacks?: readonly LlmModelRoute[];
}

export interface MixingStatus {
  readonly schema: "rma.session-view/v1";
  readonly bridge: {
    readonly instance_id: string;
    readonly heartbeat: BridgeHeartbeat;
    readonly health: Record<string, JsonValue>;
  };
  readonly project: Record<string, JsonValue>;
}

export type MixingStatusReader = (signal: AbortSignal) => Promise<MixingStatus>;

export interface ReloadableMixingRuntime extends MixingRuntime {
  renderPreview(request: MixingPreviewRequest): Promise<MixingPreviewResult>;
  drain(): Promise<void>;
  duringGeneration<T>(operation: () => Promise<T>): Promise<T>;
}

export const mixingPluginReloadingCode = "RMA_PLUGIN_RELOADING" as const;

export class MixingPluginReloadingError extends Error {
  public readonly code = mixingPluginReloadingCode;

  public constructor() {
    super("mixing runtime is draining for plugin reload");
    this.name = "MixingPluginReloadingError";
  }
}

interface HandoffGeneration {
  beginDrain(): Promise<void>;
}

interface HandoffState {
  current?: HandoffGeneration;
}

const processHandoff = globalThis as typeof globalThis & {
  __reaperMixingAgentHandoffV2?: HandoffState;
};

export function createReloadableMixingRuntime(
  initialize: () => Promise<MixingRuntime>,
): ReloadableMixingRuntime {
  let runtime: Promise<MixingRuntime> | undefined;
  let accepting = true;
  let drainTask: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const handoff = processHandoff.__reaperMixingAgentHandoffV2 ??= {};
  const previous = handoff.current;
  const ready = previous?.beginDrain() ?? Promise.resolve();
  const getRuntime = async (): Promise<MixingRuntime> => {
    runtime ??= initialize();
    return runtime;
  };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(new MixingPluginReloadingError());
    const pending = ready.then(async () => {
      if (!accepting) throw new MixingPluginReloadingError();
      return operation();
    });
    active.add(pending);
    void pending.then(
      () => active.delete(pending),
      () => active.delete(pending),
    );
    return pending;
  };
  const generation: HandoffGeneration = {
    beginDrain: () => drainTask ??= (async () => {
      accepting = false;
      await ready;
      await Promise.allSettled(active);
      if (handoff.current === generation) delete handoff.current;
    })(),
  };
  handoff.current = generation;
  return {
    run: (request) => track(async () => (await getRuntime()).run(request)),
    renderPreview: (request) => track(async () => {
      const current = await getRuntime();
      const renderPreview = current.renderPreview;
      if (!renderPreview) throw new Error("RMA_RENDER_UNAVAILABLE: mixing runtime has no render-only entry point");
      return renderPreview.call(current, request);
    }),
    recordDelivery: (request) => track(async () => (await getRuntime()).recordDelivery(request)),
    resumePending: (request) => track(async () => (await getRuntime()).resumePending?.(request)),
    findRenderedVersion: (sessionId, version) => track(async () =>
      (await getRuntime()).findRenderedVersion?.(sessionId, version)),
    findLatestRendered: (sessionId) => track(async () =>
      (await getRuntime()).findLatestRendered?.(sessionId)),
    findProjectRendered: (projectName, version) => track(async () =>
      (await getRuntime()).findProjectRendered?.(projectName, version)),
    recordProjectFeedback: (request) => track(async () =>
      (await getRuntime()).recordProjectFeedback?.(request)),
    duringGeneration: track,
    drain: generation.beginDrain,
  };
}

export function createMixingRuntime(
  config: MixingPluginConfig,
  llm: RoutedLlm,
  mutationQueue: MutationQueue = new SerialMutationQueue(),
  defaultModel?: () => LlmModelSelection,
): ReloadableMixingRuntime {
  const initialize = async (): Promise<MixingRuntime> => {
    const local = await loadConfig(config.configPath);
    try {
      await access(local.paths.ffmpegExecutable, constants.X_OK);
    } catch {
      throw new Error(`configured FFmpeg executable is not runnable: ${local.paths.ffmpegExecutable}`);
    }
    const spool = new BridgeSpool(local.paths.runtimeRoot, config.bridgeInstanceId, {
      pollIntervalMs: local.reaper.pollIntervalMs,
    });
    const requester = new ExternalRenderBridgeRequester(
      new SpoolBridgeRequester(spool),
      new ReaperCliRenderWorker({
        reaperExecutable: local.paths.reaperExecutable,
        workerScriptPath: join(
          local.paths.reaperResourcePath,
          "Scripts",
          "REAPER Mixing Agent",
          "RenderWorker.lua",
        ),
        audioWorkRoot: local.paths.audioWorkRoot,
        pollIntervalMs: local.reaper.pollIntervalMs,
      }),
    );
    const artifactStore = new LocalArtifactStore(join(local.paths.audioWorkRoot, "qq-imports"));
    const demoPublisher = new FfmpegDemoPublisher({
      audioWorkRoot: local.paths.audioWorkRoot,
      ffmpegExecutable: local.paths.ffmpegExecutable,
      artifactStore,
      timeoutMs: local.reaper.renderTimeoutMs,
    });
    const projectRegistry = new JsonProjectRegistry(join(
      local.paths.runtimeRoot,
      "projects",
      "registry.json",
    ));
    const basePlanner = new DshMixIntentPlanner(llm, () => {
      if (config.plannerProvider && config.plannerModel) {
        return {
          provider: config.plannerProvider,
          model: config.plannerModel,
          ...(config.plannerFallbacks?.length ? { fallbacks: config.plannerFallbacks } : {}),
        };
      }
      if (!defaultModel) throw new Error("请先在网页「设置 → 模型」中配置供应商并选择默认模型。");
      return defaultModel();
    });
    const fabFilterPolicy = new FabFilterMixPolicy({
      requester,
      installed: await installedFabFilterPlugins(config.configPath),
      commandTimeoutMs: local.reaper.commandTimeoutMs,
    });
    const engine = new ReaperMixEngine({
      requester,
      audioWorkRoot: local.paths.audioWorkRoot,
      commandTimeoutMs: local.reaper.commandTimeoutMs,
      renderTimeoutMs: local.reaper.renderTimeoutMs,
    });
    return new LedgerMixingRuntime({
      planner: {
        plan: async (input) => fabFilterPolicy.resolve(await basePlanner.plan(input)),
      },
      analyzer: new ReaperMixAnalyzer({
        requester,
        audioWorkRoot: local.paths.audioWorkRoot,
        commandTimeoutMs: local.reaper.commandTimeoutMs,
        renderTimeoutMs: local.reaper.renderTimeoutMs,
      }),
      engine,
      renderer: engine,
      artifactStore,
      publishDemo: demoPublisher.publish.bind(demoPublisher),
      ledgerForSession: (sessionId) => new EventLedger(join(
        local.paths.runtimeRoot,
        "sessions",
        sessionId,
        "events.jsonl",
      )),
      projectRegistry,
      onProjectionError: () => process.emitWarning(
        "project registry projection update failed; the Mixing Session ledger remains authoritative",
        { code: "RMA_PROJECT_REGISTRY_PROJECTION_FAILED" },
      ),
      mutationQueue,
      importMedia: async (files, sessionId, signal) => {
        signal.throwIfAborted();
        const receipt = await requester.request({
          sessionId,
          operation: "media.import",
          timeoutMs: local.reaper.commandTimeoutMs,
          payload: {
            files: files.map((file) => ({
              artifactId: file.artifactId,
              path: file.filePath,
              trackName: file.trackName,
            })),
          },
        });
        if (receipt.status !== "succeeded") throw new Error(`REAPER media.import ${receipt.status}`);
      },
    });
  };
  return createReloadableMixingRuntime(initialize);
}

function createProjectServices(
  config: MixingPluginConfig,
  runtime: ReloadableMixingRuntime,
  mutationQueue: MutationQueue,
): {
  readonly materialLibrary: MaterialLibrary;
  readonly projectManager: ProjectManager;
} {
  let manager: Promise<ProjectManager> | undefined;
  let library: Promise<JsonlMaterialCatalog> | undefined;
  const getLibrary = async (): Promise<JsonlMaterialCatalog> => {
    library ??= loadConfig(config.configPath).then((local) => new JsonlMaterialCatalog(
      join(local.paths.runtimeRoot, "communication", "qq", "materials.jsonl"),
    ));
    return library;
  };
  const materialLibrary: MaterialLibrary = {
    list: async (accountId, ownerId) => (await getLibrary()).list(accountId, ownerId),
    inventory: async (scope) => (await getLibrary()).inventory(scope),
    find: async (artifactId, scope) => (await getLibrary()).find(artifactId, scope),
  };
  const initialize = async (): Promise<ProjectManager> => {
    const local = await loadConfig(config.configPath);
    const artifactStore = new LocalArtifactStore(join(local.paths.audioWorkRoot, "qq-imports"));
    const requester = new SpoolBridgeRequester(new BridgeSpool(
      local.paths.runtimeRoot,
      config.bridgeInstanceId,
      { pollIntervalMs: local.reaper.pollIntervalMs },
    ));
    return new ReaperProjectManager({
      requester,
      mutationQueue,
      materialLibrary,
      artifactStore,
      audioWorkRoot: local.paths.audioWorkRoot,
      commandTimeoutMs: local.reaper.commandTimeoutMs,
    });
  };
  return {
    materialLibrary,
    projectManager: {
      rebuild: (request) => runtime.duringGeneration(async () => {
        manager ??= initialize();
        return (await manager).rebuild(request);
      }),
    },
  };
}

function requireResultRecord(value: unknown, operation: BridgeOperation): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${operation} returned no object result`);
  }
  return value as Record<string, JsonValue>;
}

export function createMixingStatusReader(config: MixingPluginConfig): MixingStatusReader {
  return async (signal) => {
    signal.throwIfAborted();
    const local = await loadConfig(config.configPath);
    const heartbeat = (await readBridgeStatuses(local.paths.runtimeRoot)).find(
      (candidate) => candidate.bridge_instance_id === config.bridgeInstanceId,
    );
    if (!heartbeat) throw new Error(`REAPER bridge ${config.bridgeInstanceId} is not running`);
    const spool = new BridgeSpool(local.paths.runtimeRoot, config.bridgeInstanceId, {
      pollIntervalMs: local.reaper.pollIntervalMs,
    });

    const request = async (operation: BridgeOperation): Promise<Record<string, JsonValue>> => {
      signal.throwIfAborted();
      const command = await spool.submitCommand({
        sessionId: randomUUID(),
        operation,
        timeoutMs: local.reaper.commandTimeoutMs,
        payload: {},
      });
      const receipt = await spool.waitForReceipt(
        command.command_id,
        local.reaper.commandTimeoutMs,
        signal,
      );
      if (receipt.status !== "succeeded") {
        throw new Error(`${operation} ${receipt.status}`);
      }
      return requireResultRecord(receipt.result, operation);
    };

    const health = await request("bridge.health");
    const project = await request("project.snapshot");
    return {
      schema: "rma.session-view/v1",
      bridge: { instance_id: config.bridgeInstanceId, heartbeat, health },
      project,
    };
  };
}

export function createMixingStatusTool(readStatus: MixingStatusReader) {
  return defineTool({
    name: "mixing_status",
    description:
      "Read the authoritative REAPER bridge and current project state. This tool is read-only and exposes no low-level bridge commands.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema: { type: "string", const: "rma.session-view/v1" },
          bridge: { type: "object", additionalProperties: true },
          project: { type: "object", additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return readStatus(exec.signal);
    },
  });
}

export function createMixingKnowledgeTool(
  knowledge: MixingKnowledgeLibrary = new FileMixingKnowledgeLibrary(),
) {
  return defineTool({
    name: "mixing_knowledge",
    description:
      "Search the local, versioned mixing document library used by mix_audio. Supply the concrete technique, symptom, instrument, or workflow question; results include only the most relevant documents plus core evidence rules.",
    parameters: {
      query: {
        type: "string",
        required: true,
        description: "Concrete search text, such as 主唱齿音、kick 与 bass 低频、管弦乐空间 or mastering delivery.",
      },
      limit: { type: "integer", description: "Maximum returned documents, from 1 to 8; defaults to 6." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema: { type: "string", const: "rma.mixing-knowledge/v2" },
          id: { type: "string", required: true },
          version: { type: "string", required: true },
          sha256: { type: "string", required: true },
          query: { type: "string", required: true },
          documents: { type: "array", items: { type: "object", additionalProperties: true }, required: true },
          hits: { type: "array", items: { type: "object", additionalProperties: true }, required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const request = z.strictObject({
        query: z.string().trim().min(1).max(2_000),
        limit: z.number().int().min(1).max(8).default(6),
      }).parse(args);
      const result = await knowledge.search(request);
      return {
        schema: result.schema,
        id: result.id,
        version: result.version,
        sha256: result.sha256,
        query: result.query,
        documents: result.documents.map((document) => ({ ...document })),
        hits: result.hits.map((hit) => ({ ...hit })),
      };
    },
  });
}

const operatorMixArgsSchema = z.strictObject({
  feedback: z.string().min(1),
  deliveryFormat: z.enum(["mp3", "wav"]).default("mp3"),
});

function operatorMixSessionId(agentId: string): string {
  return `dsh-mix-${createHash("sha256").update(agentId).digest("hex").slice(0, 32)}`;
}

export function createOperatorMixTool(runtime: MixingRuntime) {
  return defineTool({
    name: "mix_audio",
    description:
      "Analyze the current REAPER project, create a model-driven mix plan, apply it through the audited mixing runtime, and render one local artifact. Use only when the user explicitly asks to modify or render the current project.",
    parameters: {
      feedback: { type: "string", required: true, description: "The user's mixing request, preserved verbatim." },
      deliveryFormat: { type: "string", enum: ["mp3", "wav"] },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          iteration: { type: "integer", required: true },
          plan: { type: "object", additionalProperties: true, required: true },
          adjustments: {
            type: "array",
            required: true,
            items: { type: "object", additionalProperties: true },
          },
          artifact: { type: "object", additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(rawArgs, exec) {
      const args = operatorMixArgsSchema.parse(rawArgs);
      const agentId = String(exec.agent?.id ?? "local-operator");
      const result = await runtime.run({
        sessionId: operatorMixSessionId(agentId),
        sourceEventId: `operator:${randomUUID()}`,
        deliveryFormat: args.deliveryFormat,
        text: args.feedback,
        actor: { platform: "operator", id: agentId },
        signal: exec.signal,
      });
      return {
        iteration: result.iteration,
        plan: result.plan as unknown as Record<string, JsonValue>,
        adjustments: result.adjustments.map((adjustment) =>
          adjustment as unknown as Record<string, JsonValue>),
        artifact: result.artifact as unknown as Record<string, JsonValue>,
      };
    },
  });
}

const operatorRenderArgsSchema = z.strictObject({
  deliveryFormat: z.enum(["mp3", "wav"]).default("mp3"),
});

export function createOperatorRenderTool(runtime: MixingRuntime) {
  return defineTool({
    name: "render_demo",
    description: "Render and publish the current accepted REAPER project without analyzing, planning, importing media, or changing the mix.",
    parameters: {
      deliveryFormat: { type: "string", enum: ["mp3", "wav"] },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          iteration: { type: "integer", required: true },
          artifact: { type: "object", additionalProperties: true, required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(rawArgs, exec) {
      const args = operatorRenderArgsSchema.parse(rawArgs);
      if (!runtime.renderPreview) {
        throw new Error("RMA_RENDER_UNAVAILABLE: mixing runtime has no render-only entry point");
      }
      const agentId = String(exec.agent?.id ?? "local-operator");
      const result = await runtime.renderPreview({
        sessionId: operatorMixSessionId(agentId),
        sourceEventId: `operator-render:${randomUUID()}`,
        deliveryFormat: args.deliveryFormat,
        actor: { platform: "operator", id: agentId },
        signal: exec.signal,
      });
      return {
        iteration: result.iteration,
        artifact: result.artifact as unknown as Record<string, JsonValue>,
      };
    },
  });
}

export function apply(context: Context, config: MixingPluginConfig): () => Promise<void> {
  const mutationQueue = new SerialMutationQueue();
  const defaults = context.get("agentDefaultModel") as { currentSelection(): LlmModelSelection };
  const runtime = createMixingRuntime(config, context.llm, mutationQueue, () => defaults.currentSelection());
  const services = createProjectServices(config, runtime, mutationQueue);
  try {
    context.provide("mixingRuntime", runtime);
    context.provide("projectManager", services.projectManager);
    context.provide("materialLibrary", services.materialLibrary);
    context.tools.register(createMixingStatusTool(createMixingStatusReader(config)));
    context.tools.register(createMixingKnowledgeTool());
    context.tools.register(createOperatorMixTool(runtime));
    context.tools.register(createOperatorRenderTool(runtime));
    context.tools.register(createMaterialLibraryTool(services.materialLibrary));
    context.tools.register(createProjectRebuildTool(services.projectManager));
  } catch (error) {
    void runtime.drain();
    throw error;
  }
  return () => runtime.drain();
}
