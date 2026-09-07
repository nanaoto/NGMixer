import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { LocalArtifactStore } from "../communication/artifact-store.js";
import {
  artifactRefSchema,
  communicationErrorCodeSchema,
  type ArtifactRef,
  type CommunicationErrorCode,
  type DeliveryReceipt,
} from "../contracts/communication.js";
import type { EventLedger, LedgerEvent } from "../ledger/event-store.js";
import { SerialMutationQueue, type MutationQueue } from "../host/mutation-queue.js";
import type { DemoArtifactPublisher, DemoDeliveryFormat } from "./demo-publisher.js";
import type { MixAnalyzer } from "./analysis.js";
import type { AppliedMixAdjustment, DemoRenderer, MixEngine, RenderedDemoArtifact } from "./execution.js";
import { mixActionSchema, type MixIntentPlanner, type MixPlan } from "./intent-compiler.js";
import type { ProjectRegistry } from "./project-registry.js";

export interface AssignedInputArtifact {
  readonly artifact: ArtifactRef;
  readonly trackName: string;
}

export interface ImportedMediaFile {
  readonly artifactId: string;
  readonly filePath: string;
  readonly trackName: string;
}

function validateInputArtifacts(inputArtifacts: readonly AssignedInputArtifact[]): void {
  if (inputArtifacts.length > 16) throw new Error("a mix run accepts at most 16 input artifacts");
  const artifactIds = new Set<string>();
  const trackNames = new Set<string>();
  for (const { artifact, trackName } of inputArtifacts) {
    const parsedName = z.string().trim().min(1).max(128).refine((value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint >= 32 && codePoint !== 127;
      })).parse(trackName);
    if (artifactIds.has(artifact.artifactId)) {
      throw new Error(`input artifact is assigned more than once: ${artifact.artifactId}`);
    }
    artifactIds.add(artifact.artifactId);
    const nameIdentity = parsedName.normalize("NFC").toLocaleLowerCase("en-US");
    if (trackNames.has(nameIdentity)) {
      throw new Error(`input artifacts require distinct track names: ${parsedName}`);
    }
    trackNames.add(nameIdentity);
  }
}

function structuredErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
}

function mixingFailure(error: unknown, signal: AbortSignal): Error {
  const reason = signal.aborted ? signal.reason : error;
  if (typeof reason === "object" && reason !== null && "kind" in reason && reason.kind === "disposed") {
    return new Error("RMA_MIXING_CANCELLED: plugin generation was disposed during mixing");
  }
  if (signal.aborted) return new Error("RMA_MIXING_CANCELLED: mixing request was cancelled");
  const message = structuredErrorMessage(error)?.trim();
  if (message && message !== "[object Object]") return error instanceof Error ? error : new Error(message);
  return new Error("RMA_MIXING_FAILED: mixing failed with an unreadable error");
}

export interface MixingRuntimeRequest {
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly expectedDeliveryId?: string;
  readonly deliveryFormat?: DemoDeliveryFormat;
  readonly deliveryTarget?: MixDeliveryTarget;
  readonly text: string;
  readonly actor: {
    readonly platform: "qq" | "operator";
    readonly id: string;
    readonly displayName?: string;
  };
  readonly inputArtifacts?: readonly AssignedInputArtifact[];
  readonly signal: AbortSignal;
}

export interface MixingRuntimeResult {
  readonly iteration: number;
  readonly plan: MixPlan;
  readonly adjustments: readonly AppliedMixAdjustment[];
  readonly artifact: ArtifactRef;
  readonly rendered: RenderedDemoArtifact;
}

export interface MixingPreviewRequest {
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly expectedDeliveryId?: string;
  readonly deliveryFormat?: DemoDeliveryFormat;
  readonly deliveryTarget?: MixDeliveryTarget;
  readonly actor: MixingRuntimeRequest["actor"];
  readonly signal: AbortSignal;
}

export interface MixingPreviewResult {
  readonly iteration: number;
  readonly artifact: ArtifactRef;
  readonly rendered: RenderedDemoArtifact;
}

export interface ProjectRenderResult extends MixingPreviewResult {
  readonly projectName: string;
  readonly sessionId: string;
}

export interface ProjectFeedbackRequest {
  readonly platformMessageId: string;
  readonly sourceEventId: string;
  readonly messageId: string;
  readonly text: string;
  readonly actor: MixingRuntimeRequest["actor"];
}

export interface ProjectFeedbackResult {
  readonly projectName: string;
  readonly sessionId: string;
  readonly iteration: number;
  readonly artifact: ArtifactRef;
}

export type MixDeliveryTarget = "source" | "default-group";

export interface MixingRecoveryRequest {
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly expectedDeliveryId: string;
  readonly signal: AbortSignal;
}

export interface MixingRecoveryResult {
  readonly result: MixingRuntimeResult | MixingPreviewResult;
  readonly deliveryFormat: DemoDeliveryFormat;
  readonly deliveryTarget: MixDeliveryTarget;
}

export interface MixingRuntime {
  run(request: MixingRuntimeRequest): Promise<MixingRuntimeResult>;
  renderPreview?(request: MixingPreviewRequest): Promise<MixingPreviewResult>;
  recordDelivery(request: MixingDeliveryRecord): Promise<void>;
  resumePending?(request: MixingRecoveryRequest): Promise<MixingRecoveryResult | undefined>;
  /** Locate an existing rendered version for redelivery; never re-renders. */
  findRenderedVersion?(sessionId: string, version: number): Promise<MixingPreviewResult | undefined>;
  /** Locate the most recently rendered artifact for redelivery; never re-renders. */
  findLatestRendered?(sessionId: string): Promise<MixingPreviewResult | undefined>;
  /** Locate a project version independent of the QQ sender/conversation that asks for it. */
  findProjectRendered?(projectName: string, version?: number): Promise<ProjectRenderResult | undefined>;
  /** Attach a QQ reply to the exact delivered project artifact it comments on. */
  recordProjectFeedback?(request: ProjectFeedbackRequest): Promise<ProjectFeedbackResult | undefined>;
}

export interface MixingDeliveryRecord {
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly iteration: number;
  readonly deliveryId: string;
  readonly status: DeliveryReceipt["status"];
  readonly platformMessageId?: string;
  readonly errorCode?: CommunicationErrorCode;
  readonly artifactId?: string;
}

export interface LedgerMixingRuntimeOptions {
  readonly planner: MixIntentPlanner;
  readonly analyzer: MixAnalyzer;
  readonly engine: MixEngine;
  readonly renderer?: DemoRenderer;
  readonly artifactStore: LocalArtifactStore;
  readonly publishDemo?: DemoArtifactPublisher["publish"];
  readonly ledgerForSession: (sessionId: string) => EventLedger;
  readonly importMedia: (
    files: readonly ImportedMediaFile[],
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly maxPendingRuns?: number;
  readonly mutationQueue?: MutationQueue;
  readonly projectRegistry?: ProjectRegistry;
  readonly onProjectionError?: (error: unknown) => void;
}

function sourceEventId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>).sourceEventId;
  return typeof value === "string" ? value : undefined;
}

const renderedArtifactSchema = z.strictObject({
  projectId: z.string().min(1),
  path: z.string().min(1),
  fileName: z.string().min(1),
  sampleRate: z.literal(48_000),
  channels: z.literal(2),
  format: z.literal("wav"),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  renderBounds: z.literal("entire-project"),
  tailSeconds: z.number().nonnegative(),
  // Optional for pre-fix ledger entries; missing revision counts as stale.
  projectRevision: z.string().min(1).optional(),
});

const renderCompletedSchema = z.strictObject({
  sourceEventId: z.string().min(1),
  deliveryFormat: z.enum(["mp3", "wav"]),
  deliveryTarget: z.enum(["source", "default-group"]),
  renderMode: z.enum(["mix", "current-project"]).optional(),
  render: renderedArtifactSchema,
});

const adjustmentSchema = z.strictObject({
  actionIndex: z.number().int().nonnegative(),
  track: z.string().min(1),
  plugin: z.string().min(1),
  parameter: z.string().min(1),
  before: z.number(),
  after: z.number(),
  parameterName: z.string().optional(),
  parameterContext: z.string().optional(),
  fxSnapshot: z.array(z.strictObject({
    name: z.string(),
    formatted: z.string(),
    normalized: z.number(),
  })).optional(),
  beforeFormatted: z.string().optional(),
  afterFormatted: z.string().optional(),
  reason: z.string().min(1),
  phase: z.enum(["applied", "rollback"]),
  sourceEventId: z.string().min(1),
});

function recordPayload(event: LedgerEvent): Record<string, unknown> | undefined {
  return typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : undefined;
}

function recoverPlan(events: readonly LedgerEvent[], expectedSourceEventId: string): MixPlan | undefined {
  const event = [...events].reverse().find((candidate) =>
    candidate.kind === "mix.plan-created" && sourceEventId(candidate.payload) === expectedSourceEventId);
  const payload = event ? recordPayload(event) : undefined;
  if (!payload) return undefined;
  return {
    schema: "rma.mix-plan/v2",
    sourceEventId: z.string().min(1).parse(payload.sourceEventId),
    sourceText: z.string().parse(payload.sourceText),
    summary: z.string().min(1).parse(payload.summary),
    actions: mixActionSchema.array().min(1).max(12).parse(payload.actions),
    ...(Array.isArray(payload.preservationConstraints) ? {
      preservationConstraints: z.string().array().parse(payload.preservationConstraints),
    } : {}),
    ...(typeof payload.parentSourceEventId === "string" ? {
      parentSourceEventId: payload.parentSourceEventId,
    } : {}),
  };
}

function recoverAdjustments(
  events: readonly LedgerEvent[],
  expectedSourceEventId: string,
): AppliedMixAdjustment[] {
  return events.flatMap((event) => {
    if (event.kind !== "mix.effect-adjusted") return [];
    const parsed = adjustmentSchema.safeParse(event.payload);
    if (!parsed.success || parsed.data.sourceEventId !== expectedSourceEventId || parsed.data.phase !== "applied") {
      return [];
    }
    const { phase: _phase, sourceEventId: _sourceEventId, ...adjustment } = parsed.data;
    return [adjustment];
  });
}

function recoverRenderCompleted(
  events: readonly LedgerEvent[],
  expectedSourceEventId: string,
): { readonly iteration: number; readonly evidence: z.infer<typeof renderCompletedSchema> } | undefined {
  const event = [...events].reverse().find((candidate) =>
    candidate.kind === "demo.render-completed" && sourceEventId(candidate.payload) === expectedSourceEventId);
  if (!event) return undefined;
  return { iteration: event.iteration, evidence: renderCompletedSchema.parse(event.payload) };
}

function unresolvedPublication(
  events: readonly LedgerEvent[],
  expectedSourceEventId: string,
): z.infer<typeof renderCompletedSchema> | undefined {
  const published = new Set(events.flatMap((event) =>
    event.kind === "demo.rendered" && sourceEventId(event.payload)
      ? [sourceEventId(event.payload)!]
      : []));
  // A cancelled iteration is abandoned by definition: nothing will ever be
  // published for it, so its render must not hold the session hostage.
  const cancelled = new Set(events.flatMap((event) => {
    if (event.kind !== "mix.iteration.failed") return [];
    const payload = event.payload;
    const errorCode = typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).errorCode
      : undefined;
    const source = sourceEventId(payload);
    return source && errorCode === "RMA_MIXING_CANCELLED" ? [source] : [];
  }));
  for (const event of [...events].reverse()) {
    if (event.kind !== "demo.render-completed") continue;
    const evidence = renderCompletedSchema.safeParse(event.payload);
    if (evidence.success
      && evidence.data.sourceEventId !== expectedSourceEventId
      && !published.has(evidence.data.sourceEventId)
      && !cancelled.has(evidence.data.sourceEventId)) {
      return evidence.data;
    }
  }
  return undefined;
}

function recoverRendered(
  events: readonly LedgerEvent[],
  expectedSourceEventId: string,
): MixingRuntimeResult | undefined {
  const renderedEvent = [...events].reverse().find((event) =>
    event.kind === "demo.rendered" && sourceEventId(event.payload) === expectedSourceEventId);
  if (!renderedEvent) return undefined;
  const plan = recoverPlan(events, expectedSourceEventId);
  const renderedPayload = renderedEvent ? recordPayload(renderedEvent) : undefined;
  if (!plan || !renderedPayload) {
    throw new Error(`completed source ${expectedSourceEventId} is missing durable result evidence`);
  }
  const artifact = artifactRefSchema.parse(renderedPayload.artifact);
  const rendered = renderedArtifactSchema.parse(renderedPayload.render);
  const adjustments = recoverAdjustments(events, expectedSourceEventId);
  return { iteration: renderedEvent.iteration, plan, adjustments, artifact, rendered };
}

function recoverPreviewRendered(
  events: readonly LedgerEvent[],
  expectedSourceEventId: string,
): MixingPreviewResult | undefined {
  const renderedEvent = [...events].reverse().find((event) =>
    event.kind === "demo.rendered" && sourceEventId(event.payload) === expectedSourceEventId);
  const payload = renderedEvent ? recordPayload(renderedEvent) : undefined;
  if (!renderedEvent || !payload) return undefined;
  return {
    iteration: renderedEvent.iteration,
    artifact: artifactRefSchema.parse(payload.artifact),
    rendered: renderedArtifactSchema.parse(payload.render),
  };
}

const deliveryEvidenceSchema = z.strictObject({
  sourceEventId: z.string().min(1),
  deliveryId: z.string().min(1),
  status: z.enum(["pending", "delivered", "rejected", "uncertain", "abandoned"]),
  platformMessageId: z.string().min(1).optional(),
  errorCode: communicationErrorCodeSchema.optional(),
  artifactId: z.string().min(1).optional(),
});

function deliveryStates(events: readonly LedgerEvent[]): Map<string, z.infer<typeof deliveryEvidenceSchema>> {
  const states = new Map<string, z.infer<typeof deliveryEvidenceSchema>>();
  for (const event of events) {
    if (event.kind !== "communication.sent") continue;
    const evidence = deliveryEvidenceSchema.safeParse(event.payload);
    if (evidence.success) states.set(evidence.data.deliveryId, evidence.data);
  }
  return states;
}

function unresolvedDelivery(
  events: readonly LedgerEvent[],
  expectedDeliveryId?: string,
): z.infer<typeof deliveryEvidenceSchema> | undefined {
  return [...deliveryStates(events).values()].find((evidence) =>
    evidence.deliveryId !== expectedDeliveryId
    && (evidence.status === "pending" || evidence.status === "uncertain"));
}

export class LedgerMixingRuntime implements MixingRuntime {
  readonly #mutationQueue: MutationQueue;

  public constructor(private readonly options: LedgerMixingRuntimeOptions) {
    this.#mutationQueue = options.mutationQueue ?? new SerialMutationQueue(options.maxPendingRuns ?? 32);
  }

  public run(request: MixingRuntimeRequest): Promise<MixingRuntimeResult> {
    return this.#mutationQueue.run(() => this.#runOnce(request)).catch((error: unknown) => {
      throw mixingFailure(error, request.signal);
    });
  }

  public renderPreview(request: MixingPreviewRequest): Promise<MixingPreviewResult> {
    return this.#mutationQueue.run(() => this.#renderPreviewOnce(request)).catch((error: unknown) => {
      throw mixingFailure(error, request.signal);
    });
  }

  public resumePending(request: MixingRecoveryRequest): Promise<MixingRecoveryResult | undefined> {
    return this.#mutationQueue.run(() => this.#resumePendingOnce(request));
  }

  public recordDelivery(request: MixingDeliveryRecord): Promise<void> {
    return this.#mutationQueue.run(() => this.#recordDelivery(request));
  }

  /** Redelivery path: find an already-rendered version without re-rendering. */
  public async findRenderedVersion(sessionId: string, version: number): Promise<MixingPreviewResult | undefined> {
    this.#validateSessionId(sessionId);
    if (!Number.isInteger(version) || version < 1) throw new TypeError("version must be a positive integer");
    const events = await this.options.ledgerForSession(sessionId).readAll();
    // Match by version suffix so project-named prefixes (e.g. everytime-v025.wav)
    // redeliver just like legacy demo-vNNN.wav files.
    const wantedSuffix = `-v${String(version).padStart(3, "0")}.wav`;
    const renderedEvent = [...events].reverse().find((event) => {
      if (event.kind !== "demo.rendered") return false;
      const payload = recordPayload(event);
      const parsed = payload ? renderedArtifactSchema.safeParse(payload.render) : undefined;
      return parsed?.success && parsed.data.fileName.endsWith(wantedSuffix);
    });
    const payload = renderedEvent ? recordPayload(renderedEvent) : undefined;
    if (!renderedEvent || !payload) return undefined;
    return {
      iteration: renderedEvent.iteration,
      artifact: artifactRefSchema.parse(payload.artifact),
      rendered: renderedArtifactSchema.parse(payload.render),
    };
  }

  public async findLatestRendered(sessionId: string): Promise<MixingPreviewResult | undefined> {
    this.#validateSessionId(sessionId);
    const events = await this.options.ledgerForSession(sessionId).readAll();
    const renderedEvent = events.reduce<LedgerEvent | undefined>((latest, event) =>
      event.kind === "demo.rendered" && (!latest || event.iteration >= latest.iteration)
        ? event
        : latest, undefined);
    const payload = renderedEvent ? recordPayload(renderedEvent) : undefined;
    if (!renderedEvent || !payload) return undefined;
    return {
      iteration: renderedEvent.iteration,
      artifact: artifactRefSchema.parse(payload.artifact),
      rendered: renderedArtifactSchema.parse(payload.render),
    };
  }

  public async findProjectRendered(
    projectName: string,
    version?: number,
  ): Promise<ProjectRenderResult | undefined> {
    const project = await this.options.projectRegistry?.find(projectName);
    if (!project) return undefined;
    const result = version === undefined
      ? await this.findLatestRendered(project.sessionId)
      : await this.findRenderedVersion(project.sessionId, version);
    return result ? { ...result, projectName: project.name, sessionId: project.sessionId } : undefined;
  }

  public async recordProjectFeedback(
    request: ProjectFeedbackRequest,
  ): Promise<ProjectFeedbackResult | undefined> {
    const registry = this.options.projectRegistry;
    if (!registry || !request.text.trim()) return undefined;
    for (const project of await registry.list()) {
      const ledger = this.options.ledgerForSession(project.sessionId);
      const events = await ledger.readAll();
      const delivery = [...events].reverse().find((event) => {
        if (event.kind !== "communication.sent") return false;
        const parsed = deliveryEvidenceSchema.safeParse(event.payload);
        return parsed.success
          && parsed.data.status === "delivered"
          && parsed.data.platformMessageId === request.platformMessageId;
      });
      if (!delivery) continue;
      const deliveryPayload = deliveryEvidenceSchema.parse(delivery.payload);
      const renderedEvent = [...events].reverse().find((event) => {
        if (event.kind !== "demo.rendered") return false;
        const payload = recordPayload(event);
        const artifact = payload ? artifactRefSchema.safeParse(payload.artifact) : undefined;
        return deliveryPayload.artifactId
          ? artifact?.success && artifact.data.artifactId === deliveryPayload.artifactId
          : event.iteration === delivery.iteration;
      });
      const payload = renderedEvent ? recordPayload(renderedEvent) : undefined;
      if (!renderedEvent || !payload) return undefined;
      const artifact = artifactRefSchema.parse(payload.artifact);
      const duplicate = events.some((event) => event.kind === "feedback.received"
        && sourceEventId(event.payload) === request.sourceEventId);
      if (!duplicate) {
        await ledger.append({
          eventId: randomUUID(),
          sessionId: project.sessionId,
          iteration: renderedEvent.iteration,
          kind: "feedback.received",
          actor: request.actor,
          payload: {
            sourceEventId: request.sourceEventId,
            messageId: request.messageId,
            replyToPlatformMessageId: request.platformMessageId,
            projectName: project.name,
            artifactId: artifact.artifactId,
            text: request.text,
          },
          training: { use: "unknown", contentClass: "group-message" },
        });
      }
      return {
        projectName: project.name,
        sessionId: project.sessionId,
        iteration: renderedEvent.iteration,
        artifact,
      };
    }
    return undefined;
  }

  async #recordDelivery(request: MixingDeliveryRecord): Promise<void> {
    const ledger = this.options.ledgerForSession(request.sessionId);
    const previous = await ledger.readAll();
    const current = deliveryStates(previous).get(request.deliveryId);
    if (current?.status !== request.status
      || current.platformMessageId !== request.platformMessageId
      || current.errorCode !== request.errorCode
      || current.artifactId !== request.artifactId) {
    await ledger.append({
      eventId: randomUUID(),
      sessionId: request.sessionId,
      iteration: request.iteration,
      kind: "communication.sent",
      actor: { platform: "agent", id: "qq-agent" },
      payload: {
        sourceEventId: request.sourceEventId,
        deliveryId: request.deliveryId,
        status: request.status,
        ...(request.platformMessageId ? { platformMessageId: request.platformMessageId } : {}),
        ...(request.errorCode ? { errorCode: request.errorCode } : {}),
        ...(request.artifactId ? { artifactId: request.artifactId } : {}),
      },
      training: { use: "unknown", contentClass: "system-output" },
    });
    }
    if ((request.status === "delivered" || request.status === "abandoned")
      && !previous.some((event) => event.kind === "mix.iteration.completed"
        && sourceEventId(event.payload) === request.sourceEventId)) {
      await ledger.append({
        eventId: randomUUID(),
        sessionId: request.sessionId,
        iteration: request.iteration,
        kind: "mix.iteration.completed",
        actor: request.status === "abandoned"
          ? { platform: "operator", id: "local-operator" }
          : { platform: "agent", id: "qq-agent" },
        payload: { sourceEventId: request.sourceEventId, deliveryId: request.deliveryId },
        training: { use: "unknown", contentClass: "system-output" },
      });
    }
  }

  async #resumePendingOnce(request: MixingRecoveryRequest): Promise<MixingRecoveryResult | undefined> {
    request.signal.throwIfAborted();
    this.#validateSessionId(request.sessionId);
    const ledger = this.options.ledgerForSession(request.sessionId);
    const events = await ledger.readAll();
    let staged = recoverRenderCompleted(events, request.sourceEventId);
    let recovered = staged?.evidence.renderMode === "current-project"
      ? recoverPreviewRendered(events, request.sourceEventId)
      : recoverRendered(events, request.sourceEventId);
    // Stale-render guard: a cached current-project render is only valid while
    // the project revision (project_id@change_count) still matches. Otherwise
    // the same QQ message would keep re-serving audio rendered before later fixes.
    const renderer = this.options.renderer;
    if (recovered
      && staged?.evidence.renderMode === "current-project"
      && renderer?.probeProjectRevision) {
      const cachedRevision = recovered.rendered.projectRevision;
      const currentRevision = await renderer.probeProjectRevision().catch(() => cachedRevision);
      if (cachedRevision !== currentRevision) {
        recovered = undefined;
        staged = undefined;
      }
    }
    if (recovered) {
      if (!deliveryStates(events).has(request.expectedDeliveryId)) {
        await this.#recordDeliveryRequired(ledger, request, recovered.iteration, recovered.artifact.artifactId);
      }
      return {
        result: recovered,
        deliveryFormat: staged?.evidence.deliveryFormat
          ?? (recovered.artifact.mediaType === "audio/mpeg" ? "mp3" : "wav"),
        deliveryTarget: staged?.evidence.deliveryTarget ?? "source",
      };
    }
    if (staged) {
      const artifact = await this.#publishDemo(
        staged.evidence.render,
        staged.evidence.deliveryFormat,
        request.signal,
      );
      await ledger.append({
        eventId: randomUUID(),
        sessionId: request.sessionId,
        iteration: staged.iteration,
        kind: "demo.rendered",
        actor: { platform: "reaper", id: "reaper" },
        payload: { sourceEventId: request.sourceEventId, artifact, render: staged.evidence.render },
        training: { use: "unknown", contentClass: "audio-artifact" },
      });
      await this.#projectVersionProjection(request.sessionId, staged.iteration);
      await this.#recordDeliveryRequired(ledger, request, staged.iteration, artifact.artifactId);
      if (staged.evidence.renderMode === "current-project") {
        return {
          result: {
            iteration: staged.iteration,
            artifact,
            rendered: staged.evidence.render,
          },
          deliveryFormat: staged.evidence.deliveryFormat,
          deliveryTarget: staged.evidence.deliveryTarget,
        };
      }
      const plan = recoverPlan(events, request.sourceEventId);
      if (!plan) throw new Error("RMA_EXECUTION_UNCERTAIN: rendered source has no durable plan");
      return {
        result: {
          iteration: staged.iteration,
          plan,
          adjustments: recoverAdjustments(events, request.sourceEventId),
          artifact,
          rendered: staged.evidence.render,
        },
        deliveryFormat: staged.evidence.deliveryFormat,
        deliveryTarget: staged.evidence.deliveryTarget,
      };
    }
    const executionStarted = events.some((event) =>
      event.eventId !== request.sourceEventId
      && event.kind !== "mix.analysis-captured"
      && sourceEventId(event.payload) === request.sourceEventId);
    if (executionStarted) {
      throw new Error(`RMA_EXECUTION_UNCERTAIN: source ${request.sourceEventId} requires operator recovery`);
    }
    return undefined;
  }

  #validateSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionId)) {
      throw new TypeError("session id must be filename-safe");
    }
  }

  async #renderPreviewOnce(request: MixingPreviewRequest): Promise<MixingPreviewResult> {
    this.#validateSessionId(request.sessionId);
    const ledger = this.options.ledgerForSession(request.sessionId);
    const previous = await ledger.readAll();
    const blockedBy = unresolvedDelivery(previous, request.expectedDeliveryId);
    if (blockedBy) {
      throw new Error(`RMA_SESSION_FROZEN: delivery ${blockedBy.deliveryId} is ${blockedBy.status}`);
    }
    let recovered = recoverPreviewRendered(previous, request.sourceEventId);
    // Stale-render guard: cached render is only valid while the project revision
    // (project_id@change_count) still matches; otherwise re-render instead of
    // re-serving audio rendered before later fixes.
    const previewRenderer = this.options.renderer;
    if (recovered && previewRenderer?.probeProjectRevision) {
      const cachedRevision = recovered.rendered.projectRevision;
      const currentRevision = await previewRenderer.probeProjectRevision().catch(() => cachedRevision);
      if (cachedRevision !== currentRevision) recovered = undefined;
    }
    if (recovered) {
      if (request.expectedDeliveryId && !deliveryStates(previous).has(request.expectedDeliveryId)) {
        await this.#recordDeliveryRequired(ledger, request, recovered.iteration, recovered.artifact.artifactId);
      }
      return recovered;
    }
    const existingReceived = previous.find((event) => event.eventId === request.sourceEventId);
    const iteration = existingReceived?.iteration
      ?? Math.max(0, ...previous.map((event) => event.iteration)) + 1;
    if (!existingReceived) {
      await ledger.append({
        eventId: request.sourceEventId,
        sessionId: request.sessionId,
        iteration,
        kind: "communication.received",
        actor: request.actor,
        payload: { text: "Render the current accepted REAPER project without changing mix state." },
        training: { use: "unknown", contentClass: "group-message" },
      });
    }

    try {
      request.signal.throwIfAborted();
      const staged = recoverRenderCompleted(previous, request.sourceEventId);
      const rendered = staged?.evidence.render ?? await this.#requireRenderer().render({
        sessionId: request.sessionId,
        iteration,
      });
      if (!staged) {
        await ledger.append({
          eventId: randomUUID(),
          sessionId: request.sessionId,
          iteration,
          kind: "demo.render-completed",
          actor: { platform: "reaper", id: "reaper" },
          payload: {
            sourceEventId: request.sourceEventId,
            deliveryFormat: request.deliveryFormat ?? "wav",
            deliveryTarget: request.deliveryTarget ?? "source",
            renderMode: "current-project",
            render: rendered,
          },
          training: { use: "unknown", contentClass: "audio-artifact" },
        });
      }
      const format = staged?.evidence.deliveryFormat ?? request.deliveryFormat ?? "wav";
      const artifact = await this.#publishAndFinalize(ledger, request, iteration, rendered, format);
      return { iteration, artifact, rendered };
    } catch (error) {
      throw await this.#recordFailure(ledger, request, iteration, error);
    }
  }

  #requireRenderer(): DemoRenderer {
    if (!this.options.renderer) {
      throw new Error("RMA_RENDER_UNAVAILABLE: this mixing runtime has no render-only engine");
    }
    return this.options.renderer;
  }

  async #runOnce(request: MixingRuntimeRequest): Promise<MixingRuntimeResult> {
    this.#validateSessionId(request.sessionId);
    validateInputArtifacts(request.inputArtifacts ?? []);
    const ledger = this.options.ledgerForSession(request.sessionId);
    const previous = await ledger.readAll();
    const blockedBy = unresolvedDelivery(previous, request.expectedDeliveryId);
    if (blockedBy) {
      throw new Error(`RMA_SESSION_FROZEN: delivery ${blockedBy.deliveryId} is ${blockedBy.status}`);
    }
    const unpublished = unresolvedPublication(previous, request.sourceEventId);
    if (unpublished) {
      throw new Error(
        `RMA_SESSION_FROZEN: source ${unpublished.sourceEventId} awaits delivery artifact publication`,
      );
    }
    const recovered = recoverRendered(previous, request.sourceEventId);
    if (recovered) {
      if (request.expectedDeliveryId && !deliveryStates(previous).has(request.expectedDeliveryId)) {
        await this.#recordDeliveryRequired(ledger, request, recovered.iteration, recovered.artifact.artifactId);
      }
      return recovered;
    }
    const existingReceived = previous.find((event) => event.eventId === request.sourceEventId);
    const laterSourceEvidence = previous.some((event) =>
      event.eventId !== request.sourceEventId
      && event.kind !== "mix.analysis-captured"
      && sourceEventId(event.payload) === request.sourceEventId);
    if (laterSourceEvidence) {
      throw new Error(`source event ${request.sourceEventId} requires operator recovery before another mutation`);
    }
    const iteration = existingReceived?.iteration
      ?? Math.max(0, ...previous.map((event) => event.iteration)) + 1;
    if (!existingReceived) {
      await ledger.append({
        eventId: request.sourceEventId,
        sessionId: request.sessionId,
        iteration,
        kind: "communication.received",
        actor: request.actor,
        payload: {
          text: request.text,
          inputArtifacts: (request.inputArtifacts ?? []).map(({ artifact, trackName }) => ({
            artifactId: artifact.artifactId,
            trackName,
          })),
        },
        training: { use: "unknown", contentClass: "group-message" },
      });
    }

    try {
      request.signal.throwIfAborted();
      const files = await Promise.all((request.inputArtifacts ?? []).map(async ({ artifact, trackName }) => {
        const resolved = await this.options.artifactStore.resolve(artifact, request.signal);
        return { artifactId: artifact.artifactId, filePath: resolved.filePath, trackName };
      }));
      if (files.length > 0) await this.options.importMedia(files, request.sessionId, request.signal);
      const analysis = await this.options.analyzer.capture({
        sessionId: request.sessionId,
        iteration,
        signal: request.signal,
      });
      await ledger.append({
        eventId: randomUUID(),
        sessionId: request.sessionId,
        iteration,
        kind: "mix.analysis-captured",
        actor: { platform: "reaper", id: "reaper" },
        payload: { sourceEventId: request.sourceEventId, analysis },
        training: { use: "unknown", contentClass: "mix-provenance" },
      });
      const plan = await this.options.planner.plan({
        text: request.text,
        sourceEventId: request.sourceEventId,
        analysis,
        signal: request.signal,
        ...(previous.length === 0 ? {} : {
          context: {
            previousIteration: iteration - 1,
            recentTurns: previous.slice(-12).map((event) => ({
              iteration: event.iteration,
              kind: event.kind,
              payload: event.payload,
            })),
          },
        }),
      });
      await ledger.append({
        eventId: randomUUID(),
        sessionId: request.sessionId,
        iteration,
        kind: "mix.plan-created",
        actor: { platform: "agent", id: "mixing-agent" },
        payload: plan,
        training: { use: "unknown", contentClass: "mix-provenance" },
      });
      const result = await this.options.engine.run({
        sessionId: request.sessionId,
        iteration,
        plan,
        recordAdjustments: async (adjustments, phase) => {
          for (const adjustment of adjustments) {
            await ledger.append({
              eventId: randomUUID(),
              sessionId: request.sessionId,
              iteration,
              kind: "mix.effect-adjusted",
              actor: { platform: "reaper", id: "reaper" },
              payload: { ...adjustment, phase, sourceEventId: request.sourceEventId },
              training: { use: "unknown", contentClass: "mix-provenance" },
            });
          }
        },
      });
      await ledger.append({
        eventId: randomUUID(),
        sessionId: request.sessionId,
        iteration,
        kind: "demo.render-completed",
        actor: { platform: "reaper", id: "reaper" },
        payload: {
          sourceEventId: request.sourceEventId,
          deliveryFormat: request.deliveryFormat ?? "wav",
          deliveryTarget: request.deliveryTarget ?? "source",
          renderMode: "mix",
          render: result.artifact,
        },
        training: { use: "unknown", contentClass: "audio-artifact" },
      });
      const artifact = await this.#publishAndFinalize(
        ledger,
        request,
        iteration,
        result.artifact,
        request.deliveryFormat ?? "wav",
      );
      return {
        iteration,
        plan,
        adjustments: result.adjustments,
        artifact,
        rendered: result.artifact,
      };
    } catch (error) {
      throw await this.#recordFailure(ledger, request, iteration, error);
    }
  }

  async #publishAndFinalize(
    ledger: EventLedger,
    request: MixingRuntimeRequest | MixingPreviewRequest,
    iteration: number,
    rendered: RenderedDemoArtifact,
    format: DemoDeliveryFormat,
  ): Promise<ArtifactRef> {
    const artifact = await this.#publishDemo(rendered, format, request.signal);
    await ledger.append({
      eventId: randomUUID(),
      sessionId: request.sessionId,
      iteration,
      kind: "demo.rendered",
      actor: { platform: "reaper", id: "reaper" },
      payload: { sourceEventId: request.sourceEventId, artifact, render: rendered },
      training: { use: "unknown", contentClass: "audio-artifact" },
    });
    await this.#projectVersionProjection(request.sessionId, iteration);
    if (request.expectedDeliveryId) {
      await this.#recordDeliveryRequired(ledger, request, iteration, artifact.artifactId);
    } else {
      await ledger.append({
        eventId: randomUUID(),
        sessionId: request.sessionId,
        iteration,
        kind: "mix.iteration.completed",
        actor: { platform: "agent", id: "mixing-agent" },
        payload: { sourceEventId: request.sourceEventId, artifactId: artifact.artifactId },
        training: { use: "unknown", contentClass: "system-output" },
      });
    }
    return artifact;
  }

  async #projectVersionProjection(sessionId: string, iteration: number): Promise<void> {
    try {
      await this.options.projectRegistry?.advanceVersion(sessionId, iteration);
    } catch (error) {
      this.options.onProjectionError?.(error);
    }
  }

  async #recordFailure(
    ledger: EventLedger,
    request: MixingRuntimeRequest | MixingPreviewRequest,
    iteration: number,
    error: unknown,
  ): Promise<Error> {
    const failure = mixingFailure(error, request.signal);
    await ledger.append({
      eventId: randomUUID(),
      sessionId: request.sessionId,
      iteration,
      kind: "mix.iteration.failed",
      actor: { platform: "agent", id: "mixing-agent" },
      payload: {
        sourceEventId: request.sourceEventId,
        errorCode: /^RMA_[A-Z_]+:/u.test(failure.message)
          ? failure.message.split(":", 1)[0]
          : "RMA_MIXING_FAILED",
      },
      training: { use: "unknown", contentClass: "system-output" },
    });
    return failure;
  }

  async #publishDemo(
    rendered: RenderedDemoArtifact,
    format: DemoDeliveryFormat,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    return this.options.publishDemo
      ? this.options.publishDemo(rendered, format, signal)
      : this.options.artifactStore.importFile({
          kind: "audio",
          filePath: rendered.path,
          fileName: rendered.fileName,
          mediaType: "audio/wav",
        }, signal);
  }

  async #recordDeliveryRequired(
    ledger: EventLedger,
    request: Pick<MixingRuntimeRequest, "expectedDeliveryId" | "sessionId" | "sourceEventId">
      | Pick<MixingPreviewRequest, "expectedDeliveryId" | "sessionId" | "sourceEventId">
      | Pick<MixingRecoveryRequest, "expectedDeliveryId" | "sessionId" | "sourceEventId">,
    iteration: number,
    artifactId: string,
  ): Promise<void> {
    if (!request.expectedDeliveryId) return;
    await ledger.append({
      eventId: randomUUID(),
      sessionId: request.sessionId,
      iteration,
      kind: "communication.sent",
      actor: { platform: "agent", id: "qq-agent" },
      payload: {
        sourceEventId: request.sourceEventId,
        deliveryId: request.expectedDeliveryId,
        status: "pending",
        artifactId,
      },
      training: { use: "unknown", contentClass: "system-output" },
    });
  }
}
