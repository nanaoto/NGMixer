import { readFile } from "node:fs/promises";

import { z } from "zod";

const segmentSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const groupMessageSchema = z.object({
  time: z.number(),
  self_id: z.union([z.string(), z.number()]).optional(),
  post_type: z.literal("message"),
  message_type: z.literal("group"),
  message_id: z.union([z.string(), z.number()]),
  group_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]),
  raw_message: z.string(),
  message: z.array(segmentSchema),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).optional(),
});

const privateMessageSchema = z.object({
  time: z.number(),
  self_id: z.union([z.string(), z.number()]).optional(),
  post_type: z.literal("message"),
  message_type: z.literal("private"),
  message_id: z.union([z.string(), z.number()]),
  user_id: z.union([z.string(), z.number()]),
  raw_message: z.string(),
  message: z.array(segmentSchema),
  sender: z.object({ nickname: z.string().optional(), card: z.string().optional() }).optional(),
});

const messageSchema = z.discriminatedUnion("message_type", [groupMessageSchema, privateMessageSchema]);

export interface QqAttachment {
  readonly kind: "audio" | "file";
  readonly id?: string;
  readonly name?: string;
  readonly url?: string;
  readonly bytes?: number;
}

export interface QqMessage {
  readonly messageId: string;
  readonly accountId?: string;
  readonly conversation: {
    readonly kind: "private" | "group";
    readonly id: string;
  };
  readonly senderId: string;
  readonly senderName: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly replyToMessageId?: string;
  readonly attachments: readonly QqAttachment[];
}

export type QqConversation = QqMessage["conversation"];

export interface SendConversationMessageRequest {
  readonly target: QqConversation;
  readonly message: string;
  readonly replyToMessageId?: string;
  readonly mentions?: readonly string[];
}

export interface SendConversationFileRequest {
  readonly target: QqConversation;
  readonly filePath: string;
  readonly fileName: string;
}

export interface QqGroupMessage {
  readonly messageId: string;
  readonly accountId?: string;
  readonly groupId: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly replyToMessageId?: string;
  readonly attachments: readonly QqAttachment[];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function optionalBytes(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normalizeOneBotMessage(input: unknown): QqMessage {
  const event = messageSchema.parse(input);
  const text = event.message
    .filter((segment) => segment.type === "text")
    .map((segment) => optionalString(segment.data.text) ?? "")
    .join("")
    .trim() || event.raw_message;
  const reply = event.message.find((segment) => segment.type === "reply");
  const attachments = event.message.flatMap((segment): QqAttachment[] => {
    if (segment.type !== "record" && segment.type !== "file" && segment.type !== "image") return [];
    // Image segments carry a display file name plus a downloadable url; only
    // record/file segments expose an id usable with NapCat get_file.
    const id = segment.type === "image"
      ? optionalString(segment.data.file_id)
      : optionalString(segment.data.file_id) ?? optionalString(segment.data.file);
    const name = optionalString(segment.data.name) ?? optionalString(segment.data.file);
    const url = optionalString(segment.data.url);
    const bytes = optionalBytes(segment.data.file_size);
    return [{
      kind: segment.type === "record" ? "audio" : "file",
      ...(id ? { id } : {}),
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(bytes === undefined ? {} : { bytes }),
    }];
  });
  const replyToMessageId = reply ? optionalString(reply.data.id) : undefined;
  return {
    messageId: String(event.message_id),
    ...(event.self_id === undefined ? {} : { accountId: String(event.self_id) }),
    conversation: event.message_type === "group"
      ? { kind: "group", id: String(event.group_id) }
      : { kind: "private", id: String(event.user_id) },
    senderId: String(event.user_id),
    senderName: event.sender?.card || event.sender?.nickname || String(event.user_id),
    occurredAt: new Date(event.time * 1000).toISOString(),
    text,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    attachments,
  };
}

const offlineFileNoticeSchema = z.object({
  time: z.number(),
  self_id: z.union([z.string(), z.number()]).optional(),
  post_type: z.literal("notice"),
  notice_type: z.literal("offline_file"),
  user_id: z.union([z.string(), z.number()]),
  file: z.object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().min(1),
    size: z.union([z.string(), z.number()]),
    url: z.string().optional(),
  }),
});

export function normalizeOneBotOfflineFileNotice(input: unknown): QqMessage {
  const notice = offlineFileNoticeSchema.parse(input);
  const fileId = notice.file.id === undefined ? undefined : String(notice.file.id);
  const messageId = `offline-file:${fileId ?? `${notice.time}:${notice.user_id}:${notice.file.name}:${notice.file.size}`}`;
  const bytes = optionalBytes(notice.file.size);
  return {
    messageId,
    ...(notice.self_id === undefined ? {} : { accountId: String(notice.self_id) }),
    conversation: { kind: "private", id: String(notice.user_id) },
    senderId: String(notice.user_id),
    senderName: String(notice.user_id),
    occurredAt: new Date(notice.time * 1000).toISOString(),
    text: "",
    attachments: [{
      kind: "file",
      ...(fileId ? { id: fileId } : {}),
      name: notice.file.name,
      ...(notice.file.url ? { url: notice.file.url } : {}),
      ...(bytes === undefined ? {} : { bytes }),
    }],
  };
}

export function normalizeOneBotEvent(input: unknown): QqMessage {
  const envelope = z.object({
    post_type: z.string(),
    notice_type: z.string().optional(),
  }).parse(input);
  if (envelope.post_type === "notice" && envelope.notice_type === "offline_file") {
    return normalizeOneBotOfflineFileNotice(input);
  }
  return normalizeOneBotMessage(input);
}

export function normalizeOneBotGroupMessage(input: unknown): QqGroupMessage {
  const event = groupMessageSchema.parse(input);
  const normalized = normalizeOneBotMessage(event);
  return {
    messageId: normalized.messageId,
    ...(normalized.accountId === undefined ? {} : { accountId: normalized.accountId }),
    groupId: normalized.conversation.id,
    senderId: normalized.senderId,
    senderName: normalized.senderName,
    occurredAt: normalized.occurredAt,
    text: normalized.text,
    ...(normalized.replyToMessageId ? { replyToMessageId: normalized.replyToMessageId } : {}),
    attachments: normalized.attachments,
  };
}

export interface SendDemoRequest {
  readonly groupId: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly message: string;
}

export interface SendMessageRequest {
  readonly groupId: string;
  readonly message: string;
  readonly mentions?: readonly string[];
}

export interface QqDemoDelivery {
  readonly messageId?: string;
}

export interface NapCatPersonalAccount {
  readonly accountId: string;
  readonly nickname: string;
  readonly online: boolean;
  readonly good: boolean;
  readonly groupId: string;
  readonly groupName: string;
}

export class OneBotActionError extends Error {
  public constructor(
    public readonly outcome: "rejected" | "uncertain",
    message: string,
  ) {
    super(message);
    this.name = "OneBotActionError";
  }
}

export class OneBotVerificationError extends Error {
  public constructor(
    public readonly reason: "scope" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "OneBotVerificationError";
  }
}

const napCatLoginSchema = z.object({
  user_id: z.union([z.string(), z.number()]),
  nickname: z.string(),
});

const napCatStatusSchema = z.object({
  online: z.boolean(),
  good: z.boolean(),
});

const napCatGroupSchema = z.object({
  group_id: z.union([z.string(), z.number()]),
  group_name: z.string(),
});

const napCatFileSchema = z.object({
  file: z.string().min(1).optional(),
  file_path: z.string().min(1).optional(),
  file_name: z.string().min(1).optional(),
  file_size: z.union([z.string(), z.number()]).optional(),
  name: z.string().min(1).optional(),
});

export interface ResolvedOneBotAttachment {
  readonly filePath: string;
  readonly fileName: string;
  readonly bytes?: number;
}

export class OneBotHttpGateway {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly accessToken?: string,
    private readonly outboundFileResource: "path" | "base64" = "path",
  ) {}

  private async call<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new OneBotActionError("uncertain", `OneBot ${action} transport result is uncertain`);
    }
    let result: { status?: string; retcode?: number; message?: string; data?: T };
    try {
      result = await response.json() as typeof result;
    } catch {
      throw new OneBotActionError("uncertain", `OneBot ${action} returned an unreadable result`);
    }
    if (!response.ok || result.status !== "ok" || result.retcode !== 0) {
      throw new OneBotActionError("rejected", `OneBot ${action} failed: ${result.message ?? response.status}`);
    }
    return result.data as T;
  }

  public async sendDemo(request: SendDemoRequest): Promise<QqDemoDelivery> {
    await this.call<unknown>("upload_group_file", {
      group_id: request.groupId,
      file: request.filePath,
      name: request.fileName,
    });
    try {
      return await this.sendMessage(request);
    } catch {
      throw new OneBotActionError(
        "uncertain",
        "OneBot demo file was uploaded, but its traceable message was not confirmed",
      );
    }
  }

  public async sendMessage(request: SendMessageRequest): Promise<QqDemoDelivery> {
    const sent = await this.call<{ message_id?: string | number }>("send_group_msg", {
      group_id: request.groupId,
      message: [
        ...(request.mentions ?? []).map((qq) => ({ type: "at", data: { qq } })),
        { type: "text", data: { text: request.message } },
      ],
    });
    return sent.message_id === undefined ? {} : { messageId: String(sent.message_id) };
  }

  public async sendConversationMessage(request: SendConversationMessageRequest): Promise<QqDemoDelivery> {
    const message = [
      ...(request.replyToMessageId
        ? [{ type: "reply", data: { id: request.replyToMessageId } }]
        : []),
      ...(request.target.kind === "group" ? (request.mentions ?? []) : []).map((qq) => ({ type: "at", data: { qq } })),
      { type: "text", data: { text: request.message } },
    ];
    const sent = await this.call<{ message_id?: string | number }>(
      request.target.kind === "group" ? "send_group_msg" : "send_private_msg",
      request.target.kind === "group"
        ? {
            group_id: request.target.id,
            message,
          }
        : {
            user_id: request.target.id,
            message,
          },
    );
    return sent.message_id === undefined ? {} : { messageId: String(sent.message_id) };
  }

  public async sendConversationFile(request: SendConversationFileRequest): Promise<void> {
    const file = this.outboundFileResource === "base64"
      ? `base64://${(await readFile(request.filePath)).toString("base64")}`
      : request.filePath;
    await this.call<unknown>(request.target.kind === "group" ? "upload_group_file" : "upload_private_file", {
      [request.target.kind === "group" ? "group_id" : "user_id"]: request.target.id,
      file,
      name: request.fileName,
    });
  }

  public async resolveAttachment(fileId: string): Promise<ResolvedOneBotAttachment> {
    const file = napCatFileSchema.parse(await this.call<unknown>("get_file", { file_id: fileId }));
    const filePath = file.file_path ?? file.file;
    if (!filePath) throw new OneBotActionError("rejected", "NapCat get_file returned no local file path");
    const fileName = file.file_name ?? file.name ?? filePath.split(/[\\/]/u).at(-1) ?? fileId;
    const bytes = optionalBytes(file.file_size);
    return {
      filePath,
      fileName,
      ...(bytes === undefined ? {} : { bytes }),
    };
  }

  public async verifyPersonalAccount(expected: {
    readonly accountId: string;
    readonly groupId: string;
  }, signal?: AbortSignal): Promise<NapCatPersonalAccount> {
    const login = napCatLoginSchema.parse(await this.call<unknown>("get_login_info", {}, signal));
    const accountId = String(login.user_id);
    if (accountId !== expected.accountId) {
      throw new OneBotVerificationError("scope", `NapCat is logged in as QQ ${accountId}; expected ${expected.accountId}`);
    }
    const status = napCatStatusSchema.parse(await this.call<unknown>("get_status", {}, signal));
    if (!status.online || !status.good) {
      throw new OneBotVerificationError("unavailable", `NapCat personal account ${accountId} is not online and healthy`);
    }
    let group: z.infer<typeof napCatGroupSchema>;
    try {
      group = napCatGroupSchema.parse(await this.call<unknown>("get_group_info", {
        group_id: expected.groupId,
        no_cache: true,
      }, signal));
    } catch (error) {
      if (error instanceof OneBotActionError && error.outcome === "rejected") {
        throw new OneBotVerificationError("scope", "NapCat rejected the configured QQ group scope");
      }
      throw error;
    }
    const groupId = String(group.group_id);
    if (groupId !== expected.groupId) {
      throw new OneBotVerificationError("scope", `NapCat returned QQ group ${groupId}; expected ${expected.groupId}`);
    }
    return {
      accountId,
      nickname: login.nickname,
      online: status.online,
      good: status.good,
      groupId,
      groupName: group.group_name,
    };
  }
}
