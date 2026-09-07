import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import { normalizeOneBotGroupMessage, type QqGroupMessage } from "./onebot.js";

export interface OneBotWebhookServerOptions<TMessage = QqGroupMessage> {
  readonly host: "127.0.0.1" | "::1" | "localhost";
  readonly port: number;
  readonly webhookToken?: string;
  readonly personalAccountScope?: {
    readonly accountId: string;
    readonly groupId?: string;
    readonly allowedGroupIds?: readonly string[];
    readonly allowedPrivateUserIds?: readonly string[];
  };
  readonly normalizeMessage?: (input: unknown) => TMessage;
  readonly isReplyToBot?: (reference: {
    readonly accountId: string;
    readonly groupId: string;
    readonly messageId: string;
  }) => Promise<boolean>;
  readonly queueKey?: (message: TMessage) => string;
  readonly journalMessage?: (message: TMessage) => Promise<void>;
  /**
   * Passive observation: group messages in scope that are NOT addressed to the
   * bot (no @, no reply-to-bot). Normalized and reported here for context
   * collection, but never journaled as accepted turns and never processed.
   */
  readonly observeMessage?: (message: TMessage) => Promise<void>;
  /** Diagnostic hook for every event that was dropped or only observed (never journaled/processed). */
  readonly onEventIgnored?: (detail: Record<string, unknown>) => void;
  readonly processMessage: (message: TMessage) => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
  readonly maxPendingTotal?: number;
  readonly maxPendingPerQueue?: number;
}

const eventEnvelopeSchema = z.object({
  post_type: z.string(),
  self_id: z.union([z.string(), z.number()]),
  message_type: z.string().optional(),
  notice_type: z.string().optional(),
  sub_type: z.string().optional(),
  message_sent_type: z.string().optional(),
  group_id: z.union([z.string(), z.number()]).optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  sender: z.object({
    user_id: z.union([z.string(), z.number()]),
  }).optional(),
  message: z.array(z.object({
    type: z.string(),
    data: z.record(z.string(), z.unknown()),
  })).optional(),
});

export interface WebhookAddress {
  readonly host: string;
  readonly port: number;
}

export interface OneBotWebhookRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly signature?: string;
  readonly rawBody?: string;
  readonly body: unknown;
}

export interface OneBotWebhookResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function respond(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("webhook body exceeds 1 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function securelyEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isAuthorized(
  token: string | undefined,
  authorization: string | undefined,
  signature: string | undefined,
  rawBody: string | undefined,
): boolean {
  if (!token) return true;
  if (authorization === `Bearer ${token}`) return true;
  if (!signature || rawBody === undefined) return false;
  const expected = `sha1=${createHmac("sha1", token).update(rawBody).digest("hex")}`;
  return securelyEqual(signature, expected);
}

function isEmptyNormalizedMessage(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  if (!("text" in message) || !("attachments" in message)) return false;
  return typeof message.text === "string"
    && message.text.trim().length === 0
    && Array.isArray(message.attachments)
    && message.attachments.length === 0;
}

export class OneBotWebhookServer<TMessage = QqGroupMessage> {
  readonly #server: Server;
  readonly #pending = new Set<Promise<void>>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #queuedByKey = new Map<string, number>();
  readonly #maxPendingTotal: number;
  readonly #maxPendingPerQueue: number;
  #pendingCount = 0;

  public constructor(private readonly options: OneBotWebhookServerOptions<TMessage>) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("webhook port must be between 0 and 65535");
    }
    this.#maxPendingTotal = options.maxPendingTotal ?? 128;
    this.#maxPendingPerQueue = options.maxPendingPerQueue ?? 16;
    if (!Number.isInteger(this.#maxPendingTotal) || this.#maxPendingTotal < 1
      || !Number.isInteger(this.#maxPendingPerQueue) || this.#maxPendingPerQueue < 1) {
      throw new TypeError("webhook queue limits must be positive integers");
    }
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        this.options.onError?.(error);
        if (!response.headersSent) respond(response, 400, { accepted: false, error: "invalid OneBot event" });
        else response.end();
      });
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://loopback").pathname;
    if (request.method !== "POST" || path !== "/onebot/events") {
      respond(response, 404, { accepted: false });
      return;
    }
    const authorization = singleHeader(request.headers.authorization);
    const signature = singleHeader(request.headers["x-signature"]);
    const rawBody = await readBody(request);
    if (!isAuthorized(this.options.webhookToken, authorization, signature, rawBody)) {
      respond(response, 401, { accepted: false });
      return;
    }
    const result = await this.accept({
      method: request.method ?? "",
      path,
      ...(authorization === undefined ? {} : { authorization }),
      ...(signature === undefined ? {} : { signature }),
      rawBody,
      body: JSON.parse(rawBody) as unknown,
    });
    respond(response, result.status, result.body);
  }

  public async accept(request: OneBotWebhookRequest): Promise<OneBotWebhookResponse> {
    if (request.method !== "POST" || request.path !== "/onebot/events") {
      return { status: 404, body: { accepted: false } };
    }
    if (!isAuthorized(
      this.options.webhookToken,
      request.authorization,
      request.signature,
      request.rawBody,
    )) {
      return { status: 401, body: { accepted: false } };
    }
    if (this.options.personalAccountScope) {
      const envelope = eventEnvelopeSchema.parse(request.body);
      const accountId = String(envelope.self_id);
      if (accountId !== this.options.personalAccountScope.accountId) {
        return { status: 403, body: { accepted: false, error: "unexpected NapCat personal account" } };
      }
      const allowedGroups = this.options.personalAccountScope.allowedGroupIds
        ?? (this.options.personalAccountScope.groupId ? [this.options.personalAccountScope.groupId] : []);
      const allowedPrivateUsers = this.options.personalAccountScope.allowedPrivateUserIds ?? [];
      const senderIdentity = envelope.sender?.user_id ?? envelope.user_id;
      const senderId = senderIdentity === undefined ? undefined : String(senderIdentity);
      const isSelfMessage = envelope.message_sent_type === "self" || senderId === accountId;
      const mentionsBot = envelope.message?.some((segment) =>
        segment.type === "at" && String(segment.data.qq) === accountId) ?? false;
      const groupId = envelope.group_id === undefined ? undefined : String(envelope.group_id);
      const isEligibleGroupMessage = envelope.post_type === "message"
        && envelope.message_type === "group"
        && groupId !== undefined
        && allowedGroups.includes(groupId)
        && senderId !== undefined
        && !isSelfMessage;
      const replySegment = envelope.message?.find((segment) => segment.type === "reply");
      const replyId = typeof replySegment?.data.id === "string" || typeof replySegment?.data.id === "number"
        ? String(replySegment.data.id)
        : undefined;
      const repliesToBot = isEligibleGroupMessage
        && !mentionsBot
        && replyId !== undefined
        && this.options.isReplyToBot !== undefined
        ? await this.options.isReplyToBot({ accountId, groupId, messageId: replyId })
        : false;
      const isTargetGroupMessage = isEligibleGroupMessage && (mentionsBot || repliesToBot);
      const isTargetPrivateMessage = envelope.post_type === "message"
        && envelope.message_type === "private"
        && senderId !== undefined
        && allowedPrivateUsers.includes(senderId)
        && !isSelfMessage;
      const isTargetOfflineFileNotice = envelope.post_type === "notice"
        && envelope.notice_type === "offline_file"
        && senderId !== undefined
        && allowedPrivateUsers.includes(senderId)
        && !isSelfMessage;
      if (!isTargetGroupMessage && !isTargetPrivateMessage && !isTargetOfflineFileNotice) {
        // Passive observation: group message in an allowed group but not
        // addressed to the bot — normalize and keep as context, never process.
        if (isEligibleGroupMessage && this.options.observeMessage && this.options.normalizeMessage) {
          try {
            const observed = this.options.normalizeMessage(request.body);
            if (!isEmptyNormalizedMessage(observed)) await this.options.observeMessage(observed);
          } catch (error) {
            this.options.onError?.(error);
          }
          return { status: 200, body: { accepted: false, observed: true } };
        }
        this.options.onEventIgnored?.({
          reason: "not-targeted",
          post_type: envelope.post_type,
          message_type: envelope.message_type,
          notice_type: envelope.notice_type,
          sub_type: envelope.sub_type,
          user_id: senderId,
          group_id: groupId,
          raw: JSON.stringify(request.body).slice(0, 2000),
        });
        return { status: 200, body: { accepted: false, ignored: true } };
      }
    }
    const message = this.options.normalizeMessage
      ? this.options.normalizeMessage(request.body)
      : normalizeOneBotGroupMessage(request.body) as TMessage;
    if (isEmptyNormalizedMessage(message)) {
      this.options.onEventIgnored?.({
        reason: "empty-after-normalize",
        raw: JSON.stringify(request.body).slice(0, 2000),
      });
      return { status: 200, body: { accepted: false, ignored: true } };
    }
    const queueKey = this.options.queueKey?.(message) ?? "default";
    const queuedForKey = this.#queuedByKey.get(queueKey) ?? 0;
    if (this.#pendingCount >= this.#maxPendingTotal || queuedForKey >= this.#maxPendingPerQueue) {
      return { status: 429, body: { accepted: false, error: "webhook queue is full" } };
    }
    this.#pendingCount += 1;
    this.#queuedByKey.set(queueKey, queuedForKey + 1);
    try {
      await this.options.journalMessage?.(message);
    } catch (error) {
      this.#releaseQueueSlot(queueKey);
      throw error;
    }

    const previous = this.#queues.get(queueKey) ?? Promise.resolve();
    const task = previous.then(async () => {
      await this.options.processMessage(message);
    });
    const settled = task.catch((error: unknown) => {
      this.options.onError?.(error);
    }).finally(() => {
      this.#releaseQueueSlot(queueKey);
      this.#pending.delete(settled);
      if (this.#queues.get(queueKey) === settled) this.#queues.delete(queueKey);
    });
    this.#queues.set(queueKey, settled);
    this.#pending.add(settled);
    const messageId = typeof message === "object" && message !== null && "messageId" in message
      ? String(message.messageId)
      : "accepted";
    return { status: 202, body: { accepted: true, messageId } };
  }

  #releaseQueueSlot(queueKey: string): void {
    this.#pendingCount -= 1;
    const remaining = (this.#queuedByKey.get(queueKey) ?? 1) - 1;
    if (remaining === 0) this.#queuedByKey.delete(queueKey);
    else this.#queuedByKey.set(queueKey, remaining);
  }

  public async start(signal?: AbortSignal): Promise<WebhookAddress> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.#server.off("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.#server.close(() => reject(signal?.reason ?? new Error("webhook startup aborted")));
      };
      this.#server.once("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#server.listen(this.options.port, this.options.host, () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo;
    return { host: this.options.host, port: address.port };
  }

  public async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }

  public async close(): Promise<void> {
    if (this.#server.listening) {
      await new Promise<void>((resolve, reject) => {
        this.#server.close((error) => error ? reject(error) : resolve());
      });
    }
    await this.drain();
  }
}
