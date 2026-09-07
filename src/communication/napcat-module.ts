import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type {
  ArtifactRef,
  ChannelRef,
  CommunicationErrorCode,
  CommunicationModule,
  CommunicationStatus,
  DeliveryReceipt,
  InboundTurn,
  InboundTurnHandler,
  OutboundMessage,
  PassiveGroupMessage,
  RetryableInboundError,
} from "../contracts/communication.js";
import {
  deliveryReceiptSchema,
  inboundTurnSchema,
  isRetryableInboundError,
  outboundMessageSchema,
} from "../contracts/communication.js";
import type {
  NapCatPersonalAccount,
  QqDemoDelivery,
  QqGroupMessage,
  QqMessage,
  QqAttachment,
  SendConversationFileRequest,
  SendConversationMessageRequest,
  SendDemoRequest,
  SendMessageRequest,
} from "../qq/onebot.js";
import {
  normalizeOneBotEvent,
  OneBotActionError,
  OneBotVerificationError,
} from "../qq/onebot.js";
import type {
  OneBotWebhookServerOptions,
  WebhookAddress,
} from "../qq/webhook-server.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface NapCatGateway {
  verifyPersonalAccount(expected: {
    readonly accountId: string;
    readonly groupId: string;
  }, signal?: AbortSignal): Promise<NapCatPersonalAccount>;
  sendMessage(request: SendMessageRequest): Promise<QqDemoDelivery>;
  sendDemo(request: SendDemoRequest): Promise<QqDemoDelivery>;
  sendConversationMessage?(request: SendConversationMessageRequest): Promise<QqDemoDelivery>;
  sendConversationFile?(request: SendConversationFileRequest): Promise<void>;
}

export interface WebhookServer {
  start(signal?: AbortSignal): Promise<WebhookAddress>;
  close(): Promise<void>;
}

export interface CommunicationRetryState {
  readonly notBefore: number;
  readonly attempts: number;
  readonly resumePolicy?: "automatic" | "manual";
}

export interface CommunicationJournal {
  recordAccepted(turn: InboundTurn): Promise<void>;
  recordProcessed(idempotencyKey: string): Promise<void>;
  listPendingAccepted(): Promise<InboundTurn[]>;
  recordAttempting(message: OutboundMessage): Promise<void>;
  recordSettled(receipt: DeliveryReceipt, settlesInboundIdempotencyKey?: string): Promise<void>;
  findDelivery(deliveryId: string): Promise<DeliveryReceipt | "attempting" | undefined>;
  hasDeliveredPlatformMessage(target: ChannelRef, platformMessageId: string): Promise<boolean>;
  readRetryState(): Promise<CommunicationRetryState | undefined>;
  recordRetryState(state: CommunicationRetryState): Promise<void>;
  clearRetryState(): Promise<void>;
  consumeManualResumeCommands(commandText: string): Promise<boolean>;
}

export interface ResolvedArtifact {
  readonly filePath: string;
  readonly fileName: string;
}

export interface StagedOutboundArtifact {
  readonly artifact: ResolvedArtifact;
  release(): Promise<void>;
}

export type ArtifactResolver = (artifact: ArtifactRef, signal: AbortSignal) => Promise<ResolvedArtifact>;
export type OutboundArtifactStager = (
  deliveryId: string,
  artifact: ArtifactRef,
  resolved: ResolvedArtifact,
  signal: AbortSignal,
) => Promise<StagedOutboundArtifact>;
export type InboundArtifactImporter = (
  attachment: QqAttachment,
  signal: AbortSignal,
) => Promise<ArtifactRef>;

export interface NapCatCommunicationModuleOptions {
  readonly gateway: NapCatGateway;
  readonly journal: CommunicationJournal;
  readonly accountId: string;
  readonly groupId: string;
  readonly allowedGroupIds?: readonly string[];
  readonly allowedPrivateUserIds?: readonly string[];
  readonly host: "127.0.0.1" | "::1" | "localhost";
  readonly port: number;
  readonly webhookToken?: string;
  readonly createWebhookServer: (options: OneBotWebhookServerOptions<QqMessage>) => WebhookServer;
  readonly resolveArtifact?: ArtifactResolver;
  readonly stageOutboundArtifact?: OutboundArtifactStager;
  readonly importAttachment?: InboundArtifactImporter;
  readonly replyWhenUnavailable?: boolean;
  readonly startupTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly now?: () => string;
  readonly onError?: (error: unknown) => void;
}

export class CommunicationError extends Error {
  public constructor(
    public readonly code: CommunicationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommunicationError";
  }
}

function asQqMessage(message: QqMessage | QqGroupMessage): QqMessage {
  if ("conversation" in message) return message;
  return {
    messageId: message.messageId,
    ...(message.accountId ? { accountId: message.accountId } : {}),
    conversation: { kind: "group", id: message.groupId },
    senderId: message.senderId,
    senderName: message.senderName,
    occurredAt: message.occurredAt,
    text: message.text,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    attachments: message.attachments,
  };
}

function attachmentIdentity(message: QqMessage, index: number): string {
  const attachment = message.attachments[index];
  if (!attachment) throw new Error(`QQ attachment ${index} is missing`);
  return attachment.id ?? attachment.name ?? String(index);
}

function opaqueArtifactId(message: QqMessage, index: number): string {
  const identity = [
    message.accountId,
    message.conversation.kind,
    message.conversation.id,
    message.messageId,
    message.attachments[index]?.kind,
    attachmentIdentity(message, index),
  ].join("\0");
  return `artifact:${createHash("sha256").update(identity).digest("hex")}`;
}

export function qqMessageToInboundTurn(
  input: QqMessage | QqGroupMessage,
  importedAttachments?: readonly ArtifactRef[],
): InboundTurn {
  const message = asQqMessage(input);
  if (!message.accountId) {
    throw new CommunicationError("RMA_COMM_SCOPE_MISMATCH", "QQ message has no NapCat account identity");
  }
  return inboundTurnSchema.parse({
    schema: "rma.inbound-turn/v2",
    idempotencyKey: `qq:${message.accountId}:${message.conversation.kind}:${message.conversation.id}:${message.messageId}`,
    channel: {
      kind: "qq",
      accountId: message.accountId,
      conversation: message.conversation,
    },
    messageId: message.messageId,
    sender: {
      id: message.senderId,
      ...(message.senderName ? { displayName: message.senderName } : {}),
    },
    occurredAt: message.occurredAt,
    text: message.text,
    ...(message.replyToMessageId ? { replyTo: { messageId: message.replyToMessageId } } : {}),
    attachments: importedAttachments ?? message.attachments.map((attachment, index) => ({
      schema: "rma.artifact-ref/v1",
      artifactId: opaqueArtifactId(message, index),
      kind: attachment.kind,
      availability: "metadata-only",
      ...(attachment.name ? { fileName: attachment.name } : {}),
      ...(attachment.bytes === undefined ? {} : { bytes: attachment.bytes }),
    })),
  });
}

export class NapCatCommunicationModule implements CommunicationModule {
  readonly #handlers = new Set<InboundTurnHandler>();
  readonly #deliveries = new Map<string, Promise<DeliveryReceipt>>();
  readonly #materializedTurns = new Map<string, Promise<InboundTurn>>();
  readonly #passiveMessages = new Map<string, PassiveGroupMessage[]>();
  readonly #deferredLiveTurns = new Map<string, InboundTurn>();
  readonly #lifetime = new AbortController();
  readonly #now: () => string;
  #state: CommunicationStatus["state"] = "stopped";
  #errorCode: CommunicationErrorCode | undefined;
  #account: NapCatPersonalAccount | undefined;
  #server: WebhookServer | undefined;
  #endpoint: string | undefined;
  #replay: Promise<void> = Promise.resolve();
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryNotBefore = 0;
  #retryAttempts = 0;
  #retryResumePolicy: "automatic" | "manual" = "automatic";
  #recovering = false;
  #queuedReplays = 0;

  public constructor(private readonly options: NapCatCommunicationModuleOptions) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public subscribe(handler: InboundTurnHandler): () => void {
    this.#handlers.add(handler);
    if (this.#state === "ready") void this.#resumePending().catch((error: unknown) => {
      this.options.onError?.(error);
    });
    return () => this.#handlers.delete(handler);
  }

  public async start(signal?: AbortSignal): Promise<void> {
    if (this.#state !== "stopped" && this.#state !== "failed") {
      throw new Error(`NapCat communication module is ${this.#state}`);
    }
    signal?.throwIfAborted();
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort(signal?.reason);
    signal?.addEventListener("abort", abortAttempt, { once: true });
    const timeout = setTimeout(() => attempt.abort(), this.options.startupTimeoutMs ?? 5_000);
    this.#state = "starting";
    // Keep the inbox closed until durable retry state has been restored and the
    // initial pending journal has been inspected. A listener may accept traffic
    // immediately before start() resolves.
    this.#recovering = true;
    try {
      for (const groupId of this.#allowedGroupIds()) {
        const verified = await this.options.gateway.verifyPersonalAccount({
          accountId: this.options.accountId,
          groupId,
        }, attempt.signal);
        this.#account ??= verified;
      }
      if (!this.#account) throw new Error("NapCat communication module has no verified QQ group scope");
      this.#server = this.options.createWebhookServer({
        host: this.options.host,
        port: this.options.port,
        ...(this.options.webhookToken ? { webhookToken: this.options.webhookToken } : {}),
        personalAccountScope: {
          accountId: this.#account.accountId,
          allowedGroupIds: this.#allowedGroupIds(),
          allowedPrivateUserIds: this.options.allowedPrivateUserIds ?? [],
        },
        isReplyToBot: ({ accountId, groupId, messageId }) =>
          this.options.journal.hasDeliveredPlatformMessage({
            kind: "qq",
            accountId,
            conversation: { kind: "group", id: groupId },
          }, messageId),
        normalizeMessage: normalizeOneBotEvent,
        queueKey: (message) => `${message.conversation.kind}:${message.conversation.id}`,
        journalMessage: async (message) => {
          await this.options.journal.recordAccepted(await this.#materializeTurn(message));
        },
        observeMessage: async (message) => {
          if (message.conversation.kind !== "group") return;
          const key = message.conversation.id;
          const buffer = this.#passiveMessages.get(key) ?? [];
          buffer.push({
            senderId: message.senderId,
            senderName: message.senderName,
            occurredAt: message.occurredAt,
            text: message.text,
          });
          if (buffer.length > 50) buffer.shift();
          this.#passiveMessages.set(key, buffer);
        },
        processMessage: async (message) => {
          const key = this.#messageKey(message);
          try {
            const turn = await this.#materializeTurn(message);
            if (this.#retryResumePolicy === "manual" && turn.text.trim() === "继续") {
              if (await this.#consumeManualResumeCommands()) this.#scheduleReplay();
              return;
            }
            if (this.#recovering || this.#isBackpressured()) {
              this.#deferredLiveTurns.set(turn.idempotencyKey, turn);
              this.#requestReplay();
              return;
            }
            try {
              await this.#dispatch(turn);
            } catch (error) {
              if (!await this.#deferIfRetryable(error)) throw error;
            }
          } finally {
            this.#materializedTurns.delete(key);
          }
        },
        ...(this.options.onError ? { onError: this.options.onError } : {}),
      });
      const retryState = await this.options.journal.readRetryState();
      if (retryState) {
        this.#retryNotBefore = retryState.notBefore;
        this.#retryAttempts = retryState.attempts;
        this.#retryResumePolicy = retryState.resumePolicy ?? "automatic";
      }
      const pendingAtStartup = await this.options.journal.listPendingAccepted();
      const address = await this.#server.start(attempt.signal);
      const host = address.host === "::1" ? "[::1]" : address.host;
      this.#endpoint = `http://${host}:${address.port}/onebot/events`;
      this.#state = "ready";
      this.#errorCode = undefined;
      if (!retryState && pendingAtStartup.length === 0) this.#recovering = false;
      void this.#resumePending().catch((error: unknown) => {
        this.options.onError?.(error);
      });
    } catch (error) {
      const failedServer = this.#server;
      this.#server = undefined;
      this.#endpoint = undefined;
      this.#account = undefined;
      this.#recovering = false;
      this.#retryNotBefore = 0;
      this.#retryAttempts = 0;
      this.#retryResumePolicy = "automatic";
      let cleanupFailed = false;
      if (failedServer) {
        try {
          await failedServer.close();
        } catch (cleanupError) {
          cleanupFailed = true;
          this.options.onError?.(cleanupError);
        }
      }
      this.#state = "failed";
      if (cleanupFailed) {
        this.#errorCode = "RMA_COMM_RETRY_UNSAFE";
        throw new CommunicationError(this.#errorCode, "NapCat webhook cleanup failed; automatic retry is unsafe");
      }
      if (error instanceof OneBotVerificationError) {
        this.#errorCode = error.reason === "scope" ? "RMA_COMM_SCOPE_MISMATCH" : "RMA_COMM_UNAVAILABLE";
        throw new CommunicationError(this.#errorCode, error.message);
      }
      this.#errorCode = "RMA_COMM_UNAVAILABLE";
      throw new CommunicationError(
        this.#errorCode,
        error instanceof Error ? error.message : "NapCat communication startup failed",
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortAttempt);
    }
  }

  public async close(): Promise<void> {
    this.#lifetime.abort();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server) await server.close();
    await this.#replay;
    this.#endpoint = undefined;
    this.#account = undefined;
    this.#errorCode = undefined;
    this.#state = "stopped";
  }

  public async status(signal: AbortSignal): Promise<CommunicationStatus> {
    signal.throwIfAborted();
    return {
      schema: "rma.communication-status/v1",
      state: this.#state,
      channel: {
        kind: "qq",
        accountId: this.options.accountId,
        conversationId: this.options.groupId,
        ...(this.#account?.nickname ? { displayName: this.#account.nickname } : {}),
      },
      ...(this.#endpoint ? { endpoint: this.#endpoint } : {}),
      ...(this.#errorCode ? { errorCode: this.#errorCode } : {}),
    };
  }

  public recentPassiveMessages(conversationId: string, limit: number): readonly PassiveGroupMessage[] {
    const buffer = this.#passiveMessages.get(conversationId) ?? [];
    return buffer.slice(Math.max(0, buffer.length - Math.max(0, limit)));
  }

  #scheduleReplay(): void {
    this.#queuedReplays += 1;
    this.#replay = this.#replay.then(async () => {
      this.#queuedReplays -= 1;
      if (!this.#recovering) return;
      if (this.#state !== "ready") return;
      if (this.#retryResumePolicy === "manual" && !await this.#consumeManualResumeCommands()) return;
      if (this.#isBackpressured()) {
        this.#armRetryTimer();
        return;
      }
      const pending = await this.options.journal.listPendingAccepted();
      if (pending.length === 0) {
        await this.#completeRecoveryIfIdle();
        return;
      }
      for (const turn of pending) {
        try {
          await this.#dispatch(turn);
          this.#deferredLiveTurns.delete(turn.idempotencyKey);
        } catch (error) {
          if (await this.#deferIfRetryable(error)) return;
          this.#deferredLiveTurns.delete(turn.idempotencyKey);
          await this.#drainDeferredAfterNonRetryableFailure();
          throw error;
        }
      }
      const remaining = await this.options.journal.listPendingAccepted();
      if (remaining.length === 0) {
        await this.#completeRecoveryIfIdle();
        return;
      }
      const attempted = new Set(pending.map((turn) => turn.idempotencyKey));
      if (!remaining.some((turn) => attempted.has(turn.idempotencyKey))) this.#scheduleReplay();
    }).catch((error: unknown) => {
      this.options.onError?.(error);
    });
  }

  #requestReplay(): void {
    this.#recovering = true;
    this.#scheduleReplay();
  }

  async #resumePending(): Promise<void> {
    const pending = await this.options.journal.listPendingAccepted();
    if (this.#recovering || pending.length > 0 || this.#retryAttempts > 0) this.#requestReplay();
  }

  #isBackpressured(): boolean {
    return this.#retryResumePolicy === "manual" || Date.now() < this.#retryNotBefore;
  }

  async #deferIfRetryable(error: unknown): Promise<boolean> {
    if (!isRetryableInboundError(error)) return false;
    this.options.onError?.(error);
    await this.#deferReplay(error);
    return true;
  }

  async #deferReplay(error: RetryableInboundError): Promise<void> {
    this.#retryAttempts += 1;
    this.#recovering = true;
    this.#retryResumePolicy = error.resumePolicy ?? "automatic";
    const base = Math.max(1, this.options.retryBaseDelayMs ?? 5_000);
    const maximum = Math.max(base, this.options.retryMaxDelayMs ?? 300_000);
    const exponential = Math.min(maximum, base * (2 ** Math.min(this.#retryAttempts - 1, 20)));
    const hinted = Number.isFinite(error.retryAfterMs) ? Math.max(0, error.retryAfterMs ?? 0) : 0;
    const delay = Math.max(exponential, hinted);
    const now = Date.now();
    const deadline = delay >= Number.MAX_SAFE_INTEGER - now ? Number.MAX_SAFE_INTEGER : now + delay;
    this.#retryNotBefore = this.#retryResumePolicy === "manual"
      ? 0
      : Math.max(this.#retryNotBefore, deadline);
    await this.options.journal.recordRetryState({
      notBefore: this.#retryNotBefore,
      attempts: this.#retryAttempts,
      resumePolicy: this.#retryResumePolicy,
    });
    this.#armRetryTimer();
  }

  async #completeRecoveryIfIdle(): Promise<void> {
    if (this.#queuedReplays > 0) return;
    await this.options.journal.clearRetryState();
    if (this.#queuedReplays > 0) return;
    const pending = await this.options.journal.listPendingAccepted();
    if (pending.length > 0) {
      this.#scheduleReplay();
      return;
    }
    this.#retryAttempts = 0;
    this.#retryNotBefore = 0;
    this.#retryResumePolicy = "automatic";
    this.#deferredLiveTurns.clear();
    this.#recovering = false;
  }

  async #drainDeferredAfterNonRetryableFailure(): Promise<void> {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    await this.options.journal.clearRetryState();
    this.#retryAttempts = 0;
    this.#retryNotBefore = 0;
    this.#retryResumePolicy = "automatic";
    while (this.#deferredLiveTurns.size > 0) {
      const batch = [...this.#deferredLiveTurns.values()];
      this.#deferredLiveTurns.clear();
      for (let index = 0; index < batch.length; index += 1) {
        const turn = batch[index]!;
        try {
          await this.#dispatch(turn);
        } catch (error) {
          if (isRetryableInboundError(error)) {
            for (const pending of batch.slice(index)) {
              this.#deferredLiveTurns.set(pending.idempotencyKey, pending);
            }
            await this.#deferIfRetryable(error);
            return;
          }
          this.options.onError?.(error);
        }
      }
    }
    this.#recovering = false;
  }

  async #consumeManualResumeCommands(): Promise<boolean> {
    if (!await this.options.journal.consumeManualResumeCommands("继续")) return false;
    this.#retryAttempts = 0;
    this.#retryNotBefore = 0;
    this.#retryResumePolicy = "automatic";
    this.#recovering = true;
    return true;
  }

  #armRetryTimer(): void {
    if (this.#lifetime.signal.aborted || this.#state !== "ready") return;
    if (this.#retryResumePolicy === "manual") return;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, this.#retryNotBefore - Date.now()));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#scheduleReplay();
    }, delay);
  }

  #messageKey(message: QqMessage): string {
    return `${message.accountId ?? "unknown"}:${message.conversation.kind}:${message.conversation.id}:${message.messageId}`;
  }

  #materializeTurn(message: QqMessage): Promise<InboundTurn> {
    const key = this.#messageKey(message);
    const existing = this.#materializedTurns.get(key);
    if (existing) return existing;
    const materialized = (async () => {
      if (!this.options.importAttachment || message.attachments.length === 0) {
        return qqMessageToInboundTurn(message);
      }
      const fallback = qqMessageToInboundTurn(message).attachments;
      const attachments = await Promise.all(message.attachments.map(async (attachment, index) => {
        try {
          return await this.options.importAttachment?.(attachment, this.#lifetime.signal) ?? fallback[index]!;
        } catch (error) {
          this.options.onError?.(error);
          return fallback[index]!;
        }
      }));
      return qqMessageToInboundTurn(message, attachments);
    })();
    this.#materializedTurns.set(key, materialized);
    void materialized.catch(() => this.#materializedTurns.delete(key));
    return materialized;
  }

  async #dispatch(turn: InboundTurn): Promise<void> {
    if (this.#handlers.size === 0) {
      if (this.options.replyWhenUnavailable === false) return;
      await this.deliver({
        schema: "rma.outbound-message/v1",
        deliveryId: `unavailable:${turn.idempotencyKey}`,
        target: turn.channel,
        text: "混音能力当前不可用，请稍后重试。",
        artifacts: [],
        settlesInboundIdempotencyKey: turn.idempotencyKey,
        replyToMessageId: turn.messageId,
        correlation: { sessionId: "communication", iteration: 1 },
      }, this.#lifetime.signal);
      await this.options.journal.recordProcessed(turn.idempotencyKey);
      return;
    }
    for (const handler of this.#handlers) await handler(turn, this.#lifetime.signal);
    await this.options.journal.recordProcessed(turn.idempotencyKey);
  }

  public async deliver(messageInput: OutboundMessage, signal: AbortSignal): Promise<DeliveryReceipt> {
    signal.throwIfAborted();
    if (this.#state !== "ready") {
      throw new CommunicationError("RMA_COMM_UNAVAILABLE", "NapCat communication module is not ready");
    }
    const message = outboundMessageSchema.parse(messageInput);
    const active = this.#deliveries.get(message.deliveryId);
    if (active) return active;
    const delivery = this.#deliverOnce(message, signal);
    this.#deliveries.set(message.deliveryId, delivery);
    return delivery;
  }

  #allowedGroupIds(): readonly string[] {
    return [...new Set([this.options.groupId, ...(this.options.allowedGroupIds ?? [])])];
  }

  #isAllowedTarget(message: OutboundMessage): boolean {
    if (message.target.kind !== "qq" || message.target.accountId !== this.options.accountId) return false;
    const conversation = message.target.conversation;
    if (conversation.kind === "group") return this.#allowedGroupIds().includes(conversation.id);
    if (conversation.kind === "private") return (this.options.allowedPrivateUserIds ?? []).includes(conversation.id);
    return false;
  }

  async #deliverOnce(message: OutboundMessage, signal: AbortSignal): Promise<DeliveryReceipt> {
    const previous = await this.options.journal.findDelivery(message.deliveryId);
    if (previous && previous !== "attempting") {
      if (message.settlesInboundIdempotencyKey) {
        await this.options.journal.recordSettled(previous, message.settlesInboundIdempotencyKey);
      }
      return previous;
    }
    if (previous === "attempting") {
      return this.#settle(message, "uncertain", "RMA_DELIVERY_UNCERTAIN");
    }
    if (!this.#isAllowedTarget(message)) {
      return this.#settle(message, "rejected", "RMA_COMM_SCOPE_MISMATCH");
    }
    if (message.artifacts.length > 1) {
      return this.#settle(message, "rejected", "RMA_ARTIFACT_UNAVAILABLE");
    }

    let resolved: ResolvedArtifact | undefined;
    let staged: StagedOutboundArtifact | undefined;
    const artifact = message.artifacts[0];
    if (artifact) {
      if (artifact.availability !== "available" || !this.options.resolveArtifact) {
        return this.#settle(message, "rejected", "RMA_ARTIFACT_UNAVAILABLE");
      }
      try {
        resolved = await this.options.resolveArtifact(artifact, signal);
        if (this.options.stageOutboundArtifact) {
          staged = await this.options.stageOutboundArtifact(message.deliveryId, artifact, resolved, signal);
          resolved = staged.artifact;
        }
      } catch {
        return this.#settle(message, "rejected", "RMA_ARTIFACT_UNAVAILABLE");
      }
    }

    const releaseStaged = async (): Promise<void> => {
      const lease = staged;
      staged = undefined;
      if (!lease) return;
      try {
        await lease.release();
      } catch (error) {
        this.options.onError?.(error);
      }
    };
    const settle = async (
      status: DeliveryReceipt["status"],
      errorCode?: string,
      platformMessageId?: string,
    ): Promise<DeliveryReceipt> => {
      const receipt = await this.#settle(message, status, errorCode, platformMessageId);
      if (status !== "uncertain") await releaseStaged();
      return receipt;
    };
    try {
      await this.options.journal.recordAttempting(message);
    } catch (error) {
      await releaseStaged();
      throw error;
    }
    try {
      const requestedTarget = message.target.conversation;
      if (requestedTarget.kind === "session") {
        return settle("rejected", "RMA_COMM_SCOPE_MISMATCH");
      }
      const target = requestedTarget.kind === "group"
        ? { kind: "group" as const, id: requestedTarget.id }
        : { kind: "private" as const, id: requestedTarget.id };
      let result: QqDemoDelivery;
      if (resolved && this.options.gateway.sendConversationFile && this.options.gateway.sendConversationMessage) {
        await this.options.gateway.sendConversationFile({
          target,
          filePath: resolved.filePath,
          fileName: resolved.fileName,
        });
        try {
          result = await this.options.gateway.sendConversationMessage({
            target,
            message: message.text,
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            ...(message.mentions?.length ? { mentions: message.mentions } : {}),
          });
        } catch {
          throw new OneBotActionError("uncertain", "OneBot file upload succeeded but message confirmation failed");
        }
      } else if (!resolved && this.options.gateway.sendConversationMessage) {
        result = await this.options.gateway.sendConversationMessage({
          target,
          message: message.text,
          ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
          ...(message.mentions?.length ? { mentions: message.mentions } : {}),
        });
      } else if (target.kind === "group") {
        result = resolved
          ? await this.options.gateway.sendDemo({
              groupId: target.id,
              filePath: resolved.filePath,
              fileName: resolved.fileName,
              message: message.text,
            })
          : await this.options.gateway.sendMessage({
              groupId: target.id,
              message: message.text,
              ...(message.mentions?.length ? { mentions: message.mentions } : {}),
            });
      } else {
        return settle("rejected", "RMA_DELIVERY_REJECTED");
      }
      return settle("delivered", undefined, result.messageId);
    } catch (error) {
      if (error instanceof OneBotActionError && error.outcome === "rejected") {
        return settle("rejected", "RMA_DELIVERY_REJECTED");
      }
      return settle("uncertain", "RMA_DELIVERY_UNCERTAIN");
    }
  }

  async #settle(
    message: OutboundMessage,
    status: DeliveryReceipt["status"],
    errorCode?: string,
    platformMessageId?: string,
  ): Promise<DeliveryReceipt> {
    const receipt = deliveryReceiptSchema.parse({
      schema: "rma.delivery-receipt/v1",
      deliveryId: message.deliveryId,
      status,
      occurredAt: this.#now(),
      ...(errorCode ? { errorCode } : {}),
      ...(platformMessageId ? { platformMessageId } : {}),
    });
    await this.options.journal.recordSettled(receipt, message.settlesInboundIdempotencyKey);
    return receipt;
  }
}

const communicationEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("inbound.accepted"),
    payload: inboundTurnSchema,
  }),
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("inbound.processed"),
    payload: z.strictObject({ idempotencyKey: z.string().min(1) }),
  }),
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("inbound.reopened"),
    payload: z.strictObject({ idempotencyKeys: z.array(z.string().min(1)).min(1) }),
  }),
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("delivery.attempting"),
    payload: outboundMessageSchema,
  }),
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("delivery.settled"),
    payload: deliveryReceiptSchema.extend({
      settlesInboundIdempotencyKey: z.string().min(1).optional(),
    }),
  }),
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("inbound.retry-deferred"),
    payload: z.strictObject({
      notBefore: z.number().int().nonnegative(),
      attempts: z.number().int().positive(),
      resumePolicy: z.enum(["automatic", "manual"]).default("automatic"),
    }),
  }),
  z.strictObject({
    schema: z.literal("rma.communication-event/v1"),
    eventId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }),
    kind: z.literal("inbound.retry-cleared"),
    payload: z.strictObject({
      resumedByInboundIdempotencyKey: z.string().min(1).optional(),
      resumedByInboundIdempotencyKeys: z.array(z.string().min(1)).min(1).optional(),
    }),
  }),
]);

type CommunicationEvent = z.infer<typeof communicationEventSchema>;

function settledInboundKeys(events: readonly CommunicationEvent[]): Set<string> {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.kind === "inbound.processed") settled.add(event.payload.idempotencyKey);
    if (event.kind === "delivery.settled" && event.payload.settlesInboundIdempotencyKey) {
      settled.add(event.payload.settlesInboundIdempotencyKey);
    }
    if (event.kind === "inbound.retry-cleared" && event.payload.resumedByInboundIdempotencyKey) {
      settled.add(event.payload.resumedByInboundIdempotencyKey);
    }
    if (event.kind === "inbound.retry-cleared" && event.payload.resumedByInboundIdempotencyKeys) {
      for (const key of event.payload.resumedByInboundIdempotencyKeys) settled.add(key);
    }
    if (event.kind === "inbound.reopened") {
      for (const key of event.payload.idempotencyKeys) settled.delete(key);
    }
  }
  return settled;
}

function processedInboundKeys(events: readonly CommunicationEvent[]): Set<string> {
  const processed = new Set<string>();
  for (const event of events) {
    if (event.kind === "inbound.processed") processed.add(event.payload.idempotencyKey);
    if (event.kind === "inbound.reopened") {
      for (const key of event.payload.idempotencyKeys) processed.delete(key);
    }
  }
  return processed;
}

function deliveryReceiptFromSettlement(
  payload: Extract<CommunicationEvent, { kind: "delivery.settled" }>["payload"],
): DeliveryReceipt {
  const { settlesInboundIdempotencyKey: _inboundKey, ...receipt } = payload;
  return deliveryReceiptSchema.parse(receipt);
}

function sameChannel(left: ChannelRef, right: ChannelRef): boolean {
  return left.kind === right.kind
    && left.accountId === right.accountId
    && left.conversation.kind === right.conversation.kind
    && left.conversation.id === right.conversation.id;
}

export class JsonlCommunicationJournal implements CommunicationJournal {
  #queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #readAll(): Promise<CommunicationEvent[]> {
    try {
      const contents = await readFile(this.path, "utf8");
      return contents.split(/\r?\n/u).filter(Boolean).map((line) => communicationEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #append(event: Omit<CommunicationEvent, "schema" | "eventId" | "occurredAt">): Promise<void> {
    const record = communicationEventSchema.parse({
      schema: "rma.communication-event/v1",
      eventId: randomUUID(),
      occurredAt: this.now(),
      ...event,
    });
    await mkdir(dirname(this.path), { recursive: true });
    const handle = await open(this.path, "a");
    try {
      await handle.write(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  public async recordAccepted(turn: InboundTurn): Promise<void> {
    await this.#exclusive(async () => {
      const exists = (await this.#readAll()).some((event) =>
        event.kind === "inbound.accepted" && event.payload.idempotencyKey === turn.idempotencyKey);
      if (exists) return;
      await this.#append({ kind: "inbound.accepted", payload: turn });
    });
  }

  public async recordProcessed(idempotencyKey: string): Promise<void> {
    await this.#exclusive(async () => {
      if (settledInboundKeys(await this.#readAll()).has(idempotencyKey)) return;
      await this.#append({ kind: "inbound.processed", payload: { idempotencyKey } });
    });
  }

  public async reopenProcessed(idempotencyKeys: readonly string[]): Promise<void> {
    await this.#exclusive(async () => {
      const keys = [...new Set(idempotencyKeys)];
      if (keys.length === 0) throw new Error("reopenProcessed requires at least one inbound idempotency key");
      const events = await this.#readAll();
      const accepted = new Set(events.flatMap((event) =>
        event.kind === "inbound.accepted" ? [event.payload.idempotencyKey] : []));
      const delivered = new Set(events.flatMap((event) =>
        event.kind === "delivery.settled" && event.payload.settlesInboundIdempotencyKey
          ? [event.payload.settlesInboundIdempotencyKey]
          : []));
      const retryCleared = new Set(events.flatMap((event) => {
        if (event.kind !== "inbound.retry-cleared") return [];
        return event.payload.resumedByInboundIdempotencyKeys
          ?? (event.payload.resumedByInboundIdempotencyKey
            ? [event.payload.resumedByInboundIdempotencyKey]
            : []);
      }));
      const processed = processedInboundKeys(events);
      for (const key of keys) {
        if (!accepted.has(key)) throw new Error(`cannot reopen unknown inbound ${key}`);
        if (delivered.has(key)) throw new Error(`cannot reopen inbound ${key} after a settled delivery`);
        if (retryCleared.has(key)) throw new Error(`cannot reopen inbound ${key} consumed as a retry control message`);
        if (!processed.has(key)) throw new Error(`cannot reopen inbound ${key} without an effective processed event`);
      }
      await this.#append({ kind: "inbound.reopened", payload: { idempotencyKeys: keys } });
    });
  }

  public async listPendingAccepted(): Promise<InboundTurn[]> {
    return this.#exclusive(async () => {
      const events = await this.#readAll();
      const processed = settledInboundKeys(events);
      return events.flatMap((event) =>
        event.kind === "inbound.accepted" && !processed.has(event.payload.idempotencyKey) ? [event.payload] : []);
    });
  }

  public async recordAttempting(message: OutboundMessage): Promise<void> {
    await this.#exclusive(async () => this.#append({ kind: "delivery.attempting", payload: message }));
  }

  public async recordSettled(receipt: DeliveryReceipt, settlesInboundIdempotencyKey?: string): Promise<void> {
    await this.#exclusive(async () => {
      const terminalInboundKey = receipt.status === "uncertain"
        ? undefined
        : settlesInboundIdempotencyKey;
      const events = await this.#readAll();
      const exists = events.some((event) => event.kind === "delivery.settled"
        && event.payload.deliveryId === receipt.deliveryId
        && event.payload.status === receipt.status
        && event.payload.settlesInboundIdempotencyKey === terminalInboundKey);
      if (exists) return;
      await this.#append({
        kind: "delivery.settled",
        payload: { ...receipt, ...(terminalInboundKey ? { settlesInboundIdempotencyKey: terminalInboundKey } : {}) },
      });
    });
  }

  public async findDelivery(deliveryId: string): Promise<DeliveryReceipt | "attempting" | undefined> {
    return this.#exclusive(async () => {
      const events = await this.#readAll();
      for (const event of events.reverse()) {
        if (event.kind === "delivery.settled" && event.payload.deliveryId === deliveryId) {
          return deliveryReceiptFromSettlement(event.payload);
        }
        if (event.kind === "delivery.attempting" && event.payload.deliveryId === deliveryId) return "attempting";
      }
      return undefined;
    });
  }

  public async hasDeliveredPlatformMessage(target: ChannelRef, platformMessageId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const events = await this.#readAll();
      const deliveredIds = new Set(events.flatMap((event) =>
        event.kind === "delivery.settled"
          && event.payload.status === "delivered"
          && event.payload.platformMessageId === platformMessageId
          ? [event.payload.deliveryId]
          : []));
      return events.some((event) => event.kind === "delivery.attempting"
        && deliveredIds.has(event.payload.deliveryId)
        && sameChannel(event.payload.target, target));
    });
  }

  public async readRetryState(): Promise<CommunicationRetryState | undefined> {
    return this.#exclusive(async () => {
      const events = await this.#readAll();
      for (const event of events.reverse()) {
        if (event.kind === "inbound.retry-cleared") return undefined;
        if (event.kind === "inbound.retry-deferred") return event.payload;
      }
      return undefined;
    });
  }

  public async recordRetryState(state: CommunicationRetryState): Promise<void> {
    await this.#exclusive(async () => this.#append({
      kind: "inbound.retry-deferred",
      payload: { ...state, resumePolicy: state.resumePolicy ?? "automatic" },
    }));
  }

  public async clearRetryState(): Promise<void> {
    await this.#exclusive(async () => {
      const events = await this.#readAll();
      let latest: CommunicationEvent | undefined;
      for (const event of events.reverse()) {
        if (event.kind === "inbound.retry-deferred" || event.kind === "inbound.retry-cleared") {
          latest = event;
          break;
        }
      }
      if (!latest || latest.kind === "inbound.retry-cleared") return;
      await this.#append({ kind: "inbound.retry-cleared", payload: {} });
    });
  }

  public async consumeManualResumeCommands(commandText: string): Promise<boolean> {
    return await this.#exclusive(async () => {
      const events = await this.#readAll();
      const settled = settledInboundKeys(events);
      let manualPauseIndex = -1;
      let clearedAfterPause = false;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]!;
        if (event.kind === "inbound.retry-cleared") {
          clearedAfterPause = true;
          continue;
        }
        if (event.kind === "inbound.retry-deferred" && event.payload.resumePolicy === "manual") {
          manualPauseIndex = index;
          break;
        }
      }
      const resumeKeys = events.flatMap((event, index) => {
        if (event.kind !== "inbound.accepted"
          || settled.has(event.payload.idempotencyKey)
          || event.payload.text.trim() !== commandText) return [];
        const durablePausedCommand = manualPauseIndex >= 0 && !clearedAfterPause && index > manualPauseIndex;
        return durablePausedCommand ? [event.payload.idempotencyKey] : [];
      });
      if (resumeKeys.length === 0) return false;
      await this.#append({
        kind: "inbound.retry-cleared",
        payload: { resumedByInboundIdempotencyKeys: resumeKeys },
      });
      return true;
    });
  }

  public async reconcileDelivery(request: {
    readonly deliveryId: string;
    readonly accountId: string;
    readonly groupId: string;
    readonly outcome: "delivered" | "abandoned";
    readonly platformMessageId?: string;
  }): Promise<DeliveryReceipt> {
    return this.#exclusive(async () => {
      if (request.outcome === "delivered" && !request.platformMessageId) {
        throw new Error("delivered reconciliation requires the actual QQ message id");
      }
      if (request.outcome === "abandoned" && request.platformMessageId) {
        throw new Error("abandoned reconciliation must not include a QQ message id");
      }
      const events = await this.#readAll();
      const attempting = [...events].reverse().find((event) =>
        event.kind === "delivery.attempting" && event.payload.deliveryId === request.deliveryId);
      if (!attempting || attempting.kind !== "delivery.attempting") {
        throw new Error(`delivery ${request.deliveryId} has no durable attempting record`);
      }
      const target = attempting.payload.target;
      if (target.kind !== "qq"
        || target.accountId !== request.accountId
        || target.conversation.kind !== "group"
        || target.conversation.id !== request.groupId) {
        throw new Error("delivery reconciliation is outside the configured QQ account or group");
      }
      const settled = [...events].reverse().find((event) =>
        event.kind === "delivery.settled" && event.payload.deliveryId === request.deliveryId);
      if (settled?.kind === "delivery.settled" && settled.payload.status !== "uncertain") {
        const existing = deliveryReceiptFromSettlement(settled.payload);
        if (existing.status === request.outcome
          && existing.platformMessageId === request.platformMessageId) return existing;
        throw new Error(`delivery ${request.deliveryId} is already settled as ${existing.status}`);
      }
      const receipt = deliveryReceiptSchema.parse({
        schema: "rma.delivery-receipt/v1",
        deliveryId: request.deliveryId,
        status: request.outcome,
        occurredAt: this.now(),
        ...(request.platformMessageId ? { platformMessageId: request.platformMessageId } : {}),
      });
      await this.#append({
        kind: "delivery.settled",
        payload: {
          ...receipt,
          ...(attempting.payload.settlesInboundIdempotencyKey
            ? { settlesInboundIdempotencyKey: attempting.payload.settlesInboundIdempotencyKey }
            : {}),
        },
      });
      return receipt;
    });
  }
}
