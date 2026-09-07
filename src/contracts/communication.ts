import { z } from "zod";

export const communicationErrorCodeSchema = z.enum([
  "RMA_COMM_UNAVAILABLE",
  "RMA_COMM_SCOPE_MISMATCH",
  "RMA_COMM_RETRY_UNSAFE",
  "RMA_DELIVERY_REJECTED",
  "RMA_DELIVERY_UNCERTAIN",
  "RMA_ARTIFACT_UNAVAILABLE",
]);

export const artifactRefSchema = z.strictObject({
  schema: z.literal("rma.artifact-ref/v1"),
  artifactId: z.string().min(1),
  kind: z.enum(["audio", "file"]),
  availability: z.enum(["metadata-only", "available"]),
  mediaType: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  bytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});

export const channelRefSchema = z.strictObject({
  kind: z.enum(["qq", "dsh", "local-ui"]),
  accountId: z.string().min(1).optional(),
  conversation: z.strictObject({
    kind: z.enum(["private", "group", "session"]),
    id: z.string().min(1),
  }),
});

export const inboundTurnSchema = z.strictObject({
  schema: z.literal("rma.inbound-turn/v2"),
  idempotencyKey: z.string().min(1),
  channel: channelRefSchema,
  messageId: z.string().min(1),
  sender: z.strictObject({
    id: z.string().min(1),
    displayName: z.string().min(1).optional(),
  }),
  occurredAt: z.string().datetime({ offset: true }),
  text: z.string(),
  replyTo: z.strictObject({ messageId: z.string().min(1) }).optional(),
  attachments: z.array(artifactRefSchema),
});

export const outboundMessageSchema = z.strictObject({
  schema: z.literal("rma.outbound-message/v1"),
  deliveryId: z.string().min(1),
  target: channelRefSchema,
  text: z.string(),
  artifacts: z.array(artifactRefSchema),
  settlesInboundIdempotencyKey: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional(),
  /** QQ user ids to @ in the sent message (group conversations only). */
  mentions: z.array(z.string().min(1)).optional(),
  correlation: z.strictObject({
    sessionId: z.string().min(1),
    iteration: z.number().int().positive(),
  }).optional(),
});

export const deliveryReceiptSchema = z.strictObject({
  schema: z.literal("rma.delivery-receipt/v1"),
  deliveryId: z.string().min(1),
  status: z.enum(["delivered", "rejected", "uncertain", "abandoned"]),
  platformMessageId: z.string().min(1).optional(),
  occurredAt: z.string().datetime({ offset: true }),
  errorCode: communicationErrorCodeSchema.optional(),
});

export const communicationStatusSchema = z.strictObject({
  schema: z.literal("rma.communication-status/v1"),
  state: z.enum(["stopped", "starting", "ready", "failed"]),
  channel: z.strictObject({
    kind: z.literal("qq"),
    accountId: z.string().min(1),
    conversationId: z.string().min(1),
    displayName: z.string().min(1).optional(),
  }),
  endpoint: z.string().url().optional(),
  errorCode: communicationErrorCodeSchema.optional(),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type ChannelRef = z.infer<typeof channelRefSchema>;
export type InboundTurn = z.infer<typeof inboundTurnSchema>;
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>;
export type CommunicationStatus = z.infer<typeof communicationStatusSchema>;
export type CommunicationErrorCode = z.infer<typeof communicationErrorCodeSchema>;

export type InboundTurnHandler = (turn: InboundTurn, signal: AbortSignal) => Promise<void>;

const RETRYABLE_INBOUND_ERROR_CODE = "RMA_INBOUND_RETRYABLE";

export class RetryableInboundError extends Error {
  public readonly code = RETRYABLE_INBOUND_ERROR_CODE;
  public readonly retryAfterMs: number | undefined;
  public readonly resumePolicy: "automatic" | "manual";

  public constructor(
    message: string,
    options: {
      readonly retryAfterMs?: number;
      readonly resumePolicy?: "automatic" | "manual";
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RetryableInboundError";
    this.retryAfterMs = options.retryAfterMs;
    this.resumePolicy = options.resumePolicy ?? "automatic";
  }
}

export function isRetryableInboundError(error: unknown): error is RetryableInboundError {
  if (typeof error !== "object" || error === null) return false;
  return "code" in error && error.code === RETRYABLE_INBOUND_ERROR_CODE;
}

export interface PassiveGroupMessage {
  readonly senderId: string;
  readonly senderName: string;
  readonly occurredAt: string;
  readonly text: string;
}

export interface CommunicationModule {
  subscribe(handler: InboundTurnHandler): () => void;
  deliver(message: OutboundMessage, signal: AbortSignal): Promise<DeliveryReceipt>;
  status(signal: AbortSignal): Promise<CommunicationStatus>;
  /**
   * Recent group messages that were observed but not addressed to the bot.
   * Read-only conversational context; implementations may keep only a bounded
   * in-memory window.
   */
  recentPassiveMessages?(conversationId: string, limit: number): readonly PassiveGroupMessage[];
}
