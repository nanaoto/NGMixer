import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChannelRef,
  DeliveryReceipt,
  InboundTurn,
  OutboundMessage,
} from "../src/contracts/communication.js";
import { RetryableInboundError } from "../src/contracts/communication.js";
import {
  NapCatCommunicationModule,
  JsonlCommunicationJournal,
  type CommunicationJournal,
  type NapCatGateway,
  type WebhookServer,
} from "../src/communication/napcat-module.js";
import {
  OneBotActionError,
  OneBotVerificationError,
  type QqMessage,
} from "../src/qq/onebot.js";
import type { OneBotWebhookServerOptions } from "../src/qq/webhook-server.js";

const groupMessage = {
  messageId: "9001",
  accountId: "42",
  conversation: { kind: "group" as const, id: "314" },
  senderId: "7",
  senderName: "Singer",
  occurredAt: "2026-08-19T08:00:00.000Z",
  text: "人声靠前一点",
  replyToMessageId: "8000",
  attachments: [{ kind: "audio" as const, id: "voice-1", name: "take.wav" }],
};

class MemoryJournal implements CommunicationJournal {
  public readonly accepted: InboundTurn[] = [];
  public readonly processed = new Set<string>();
  public readonly attempting: OutboundMessage[] = [];
  public readonly settled: DeliveryReceipt[] = [];
  public retryState: {
    readonly notBefore: number;
    readonly attempts: number;
    readonly resumePolicy?: "automatic" | "manual";
  } | undefined;
  public manualPauseAcceptedCount = 0;

  public async recordAccepted(turn: InboundTurn): Promise<void> {
    if (!this.accepted.some((candidate) => candidate.idempotencyKey === turn.idempotencyKey)) {
      this.accepted.push(turn);
    }
  }

  public async recordProcessed(idempotencyKey: string): Promise<void> {
    this.processed.add(idempotencyKey);
  }

  public async listPendingAccepted(): Promise<InboundTurn[]> {
    return this.accepted.filter((turn) => !this.processed.has(turn.idempotencyKey));
  }

  public async recordAttempting(reply: OutboundMessage): Promise<void> {
    this.attempting.push(reply);
  }

  public async recordSettled(receipt: DeliveryReceipt, settlesInboundIdempotencyKey?: string): Promise<void> {
    this.settled.push(receipt);
    if (receipt.status !== "uncertain" && settlesInboundIdempotencyKey) {
      this.processed.add(settlesInboundIdempotencyKey);
    }
  }

  public async findDelivery(deliveryId: string): Promise<DeliveryReceipt | "attempting" | undefined> {
    return [...this.settled].reverse().find((receipt) => receipt.deliveryId === deliveryId)
      ?? (this.attempting.some((reply) => reply.deliveryId === deliveryId) ? "attempting" : undefined);
  }

  public async hasDeliveredPlatformMessage(target: ChannelRef, platformMessageId: string): Promise<boolean> {
    const deliveredIds = new Set(this.settled.flatMap((receipt) =>
      receipt.status === "delivered" && receipt.platformMessageId === platformMessageId
        ? [receipt.deliveryId]
        : []));
    return this.attempting.some((message) => deliveredIds.has(message.deliveryId)
      && message.target.kind === target.kind
      && message.target.accountId === target.accountId
      && message.target.conversation.kind === target.conversation.kind
      && message.target.conversation.id === target.conversation.id);
  }

  public async readRetryState(): Promise<{
    readonly notBefore: number;
    readonly attempts: number;
    readonly resumePolicy?: "automatic" | "manual";
  } | undefined> {
    return this.retryState;
  }

  public async recordRetryState(state: {
    readonly notBefore: number;
    readonly attempts: number;
    readonly resumePolicy?: "automatic" | "manual";
  }): Promise<void> {
    if (state.resumePolicy === "manual" && this.retryState?.resumePolicy !== "manual") {
      this.manualPauseAcceptedCount = this.accepted.length;
    }
    this.retryState = state;
  }

  public async clearRetryState(): Promise<void> {
    this.retryState = undefined;
  }

  public async consumeManualResumeCommands(commandText: string): Promise<boolean> {
    const commands = this.accepted.filter((turn, index) =>
      !this.processed.has(turn.idempotencyKey)
      && turn.text.trim() === commandText
      && index >= this.manualPauseAcceptedCount);
    if (commands.length === 0) return false;
    for (const command of commands) this.processed.add(command.idempotencyKey);
    this.retryState = undefined;
    return true;
  }
}

class FakeWebhookServer implements WebhookServer {
  public started = false;
  public closed = false;

  public constructor(public readonly options: OneBotWebhookServerOptions<QqMessage>) {}

  public async start(): Promise<{ host: string; port: number }> {
    this.started = true;
    return { host: "127.0.0.1", port: 32180 };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

function createGateway(overrides: Partial<NapCatGateway> = {}): NapCatGateway {
  return {
    verifyPersonalAccount: async () => ({
      accountId: "42",
      nickname: "mix-bot",
      online: true,
      good: true,
      groupId: "314",
      groupName: "feedback",
    }),
    sendMessage: async () => ({ messageId: "out-1" }),
    sendDemo: async () => ({ messageId: "out-demo-1" }),
    ...overrides,
  };
}

test("NapCat communication module starts a scoped listener and emits platform-neutral turns", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    webhookToken: "secret",
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
    now: () => "2026-08-19T08:01:00.000Z",
  });
  const received: InboundTurn[] = [];
  communication.subscribe(async (turn) => {
    received.push(turn);
  });

  await communication.start();
  assert.equal(server?.started, true);
  assert.deepEqual(await communication.status(new AbortController().signal), {
    schema: "rma.communication-status/v1",
    state: "ready",
    channel: {
      kind: "qq",
      accountId: "42",
      conversationId: "314",
      displayName: "mix-bot",
    },
    endpoint: "http://127.0.0.1:32180/onebot/events",
  });

  await server?.options.journalMessage?.(groupMessage);
  await server?.options.processMessage(groupMessage);

  assert.equal(journal.accepted.length, 1);
  assert.equal(received.length, 1);
  const receivedTurn = received[0];
  assert.ok(receivedTurn);
  assert.match(receivedTurn.attachments[0]?.artifactId ?? "", /^artifact:[a-f0-9]{64}$/u);
  assert.equal(receivedTurn.attachments[0]?.artifactId.includes("voice-1"), false);
  assert.deepEqual({
    ...receivedTurn,
    attachments: receivedTurn.attachments.map(({ artifactId: _artifactId, ...artifact }) => artifact),
  }, {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:group:314:9001",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    messageId: "9001",
    sender: { id: "7", displayName: "Singer" },
    occurredAt: "2026-08-19T08:00:00.000Z",
    text: "人声靠前一点",
    replyTo: { messageId: "8000" },
    attachments: [{
      schema: "rma.artifact-ref/v1",
      kind: "audio",
      availability: "metadata-only",
      fileName: "take.wav",
    }],
  });

  await communication.close();
  assert.equal(server?.closed, true);
});

test("NapCat communication module gives reply admission durable bot-delivery evidence", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  await communication.start();
  await journal.recordAttempting({
    schema: "rma.outbound-message/v1",
    deliveryId: "bot-reply-source",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    text: "试听已发",
    artifacts: [],
  });
  await journal.recordSettled({
    schema: "rma.delivery-receipt/v1",
    deliveryId: "bot-reply-source",
    status: "delivered",
    platformMessageId: "bot-platform-message",
    occurredAt: "2026-08-22T00:01:00.000Z",
  });

  assert.equal(await server?.options.isReplyToBot?.({
    accountId: "42",
    groupId: "314",
    messageId: "bot-platform-message",
  }), true);
  assert.equal(await server?.options.isReplyToBot?.({
    accountId: "42",
    groupId: "314",
    messageId: "member-platform-message",
  }), false);
  await communication.close();
});

test("NapCat communication module retries a transient startup without losing subscribers", async () => {
  const journal = new MemoryJournal();
  let verificationAttempts = 0;
  let server: FakeWebhookServer | undefined;
  const received: InboundTurn[] = [];
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      verifyPersonalAccount: async () => {
        verificationAttempts += 1;
        if (verificationAttempts === 1) {
          throw new OneBotVerificationError("unavailable", "NapCat is offline");
        }
        return {
          accountId: "42",
          nickname: "mix-bot",
          online: true,
          good: true,
          groupId: "314",
          groupName: "feedback",
        };
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  communication.subscribe(async (turn) => {
    received.push(turn);
  });

  await assert.rejects(communication.start(), /NapCat is offline/u);
  assert.equal((await communication.status(new AbortController().signal)).state, "failed");

  await communication.start();
  await server?.options.journalMessage?.(groupMessage);
  await server?.options.processMessage(groupMessage);

  assert.equal(verificationAttempts, 2);
  assert.equal(received.length, 1);
  await communication.close();
});

test("NapCat communication module bounds startup verification and reports unavailable", async () => {
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      verifyPersonalAccount: async (_expected, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new OneBotVerificationError("unavailable", "verification timed out"));
        }, { once: true });
      }),
    }),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    startupTimeoutMs: 5,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });

  await assert.rejects(
    communication.start(),
    (error) => error instanceof Error
      && "code" in error
      && error.code === "RMA_COMM_UNAVAILABLE",
  );
});

test("NapCat communication module aborts and cleans up a listener that hangs during startup", async () => {
  let closes = 0;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    startupTimeoutMs: 5,
    createWebhookServer: () => ({
      start: async (signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("listener startup aborted")), { once: true });
      }),
      close: async () => { closes += 1; },
    }),
  });

  await assert.rejects(communication.start(), /listener startup aborted/u);
  assert.equal(closes, 1);
});

test("NapCat communication module stops automatic retry when a failed listener cannot close", async () => {
  const cleanupErrors: unknown[] = [];
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: () => ({
      start: async () => { throw new Error("listen failed"); },
      close: async () => { throw new Error("close failed"); },
    }),
    onError: (error) => cleanupErrors.push(error),
  });

  await assert.rejects(
    communication.start(),
    (error) => error instanceof Error
      && "code" in error
      && error.code === "RMA_COMM_RETRY_UNSAFE",
  );
  assert.equal(cleanupErrors.length, 1);
});

test("NapCat communication module journals a text delivery and returns its platform receipt", async () => {
  const journal = new MemoryJournal();
  const sent: Array<{ groupId: string; message: string }> = [];
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendMessage: async (request) => {
        sent.push(request);
        return { messageId: "qq-result-77" };
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
    now: () => "2026-08-19T08:02:00.000Z",
  });
  await communication.start();
  const reply: OutboundMessage = {
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-1",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    correlation: { sessionId: "song-1", iteration: 1 },
    text: "第 1 版已完成",
    artifacts: [],
  };

  const receipt = await communication.deliver(reply, new AbortController().signal);

  assert.deepEqual(sent, [{ groupId: "314", message: "第 1 版已完成" }]);
  assert.deepEqual(journal.attempting, [reply]);
  assert.deepEqual(receipt, {
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivery-1",
    status: "delivered",
    platformMessageId: "qq-result-77",
    occurredAt: "2026-08-19T08:02:00.000Z",
  });
  assert.deepEqual(journal.settled, [receipt]);
});

test("NapCat communication module routes allowed private and secondary-group deliveries independently", async () => {
  const requests: Array<{
    target: { kind: "private" | "group"; id: string };
    replyToMessageId?: string;
  }> = [];
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendConversationMessage: async ({ target, replyToMessageId }) => {
        requests.push({ target, ...(replyToMessageId ? { replyToMessageId } : {}) });
        return { messageId: `sent-${target.kind}-${target.id}` };
      },
    }),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    allowedGroupIds: ["314", "2718"],
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  await communication.start();

  for (const [deliveryId, kind, id] of [
    ["private-result", "private", "7"],
    ["group-result", "group", "2718"],
  ] as const) {
    const receipt = await communication.deliver({
      schema: "rma.outbound-message/v1",
      deliveryId,
      target: { kind: "qq", accountId: "42", conversation: { kind, id } },
      text: "渲染完成",
      artifacts: [],
      ...(deliveryId === "private-result" ? { replyToMessageId: "source-private-1" } : {}),
    }, new AbortController().signal);
    assert.equal(receipt.status, "delivered");
  }

  assert.deepEqual(requests, [
    { target: { kind: "private", id: "7" }, replyToMessageId: "source-private-1" },
    { target: { kind: "group", id: "2718" } },
  ]);
  await communication.close();
});

test("NapCat communication module gives OneBot only a QQ-readable staged artifact path", async () => {
  const gatewayPaths: string[] = [];
  const stagingSources: string[] = [];
  let releases = 0;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendConversationFile: async ({ filePath }) => { gatewayPaths.push(filePath); },
      sendConversationMessage: async () => ({ messageId: "staged-delivery" }),
    }),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    resolveArtifact: async () => ({
      filePath: "/private/tmp/rma-test-audio/qq-imports/digest/demo.mp3",
      fileName: "demo.mp3",
    }),
    stageOutboundArtifact: async (_deliveryId, _artifact, resolved) => {
      stagingSources.push(resolved.filePath);
      return {
        artifact: {
          filePath: "/Users/test/Library/Containers/com.tencent.qq/Data/Documents/napcat/rma-outbound/digest.mp3",
          fileName: resolved.fileName,
        },
        release: async () => { releases += 1; },
      };
    },
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  await communication.start();

  const receipt = await communication.deliver({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-staged-private-file",
    target: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    text: "新版试听",
    artifacts: [{
      schema: "rma.artifact-ref/v1",
      artifactId: `artifact:${"a".repeat(64)}`,
      kind: "audio",
      availability: "available",
      mediaType: "audio/mpeg",
      fileName: "demo.mp3",
      bytes: 1024,
      sha256: "a".repeat(64),
    }],
  }, new AbortController().signal);

  assert.equal(receipt.status, "delivered");
  assert.deepEqual(stagingSources, ["/private/tmp/rma-test-audio/qq-imports/digest/demo.mp3"]);
  assert.deepEqual(gatewayPaths, [
    "/Users/test/Library/Containers/com.tencent.qq/Data/Documents/napcat/rma-outbound/digest.mp3",
  ]);
  assert.equal(releases, 1);
  await communication.close();
});

test("NapCat communication module retains a staged artifact only for an uncertain delivery", async () => {
  let releases = 0;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendConversationFile: async () => { throw new Error("connection reset after upload began"); },
      sendConversationMessage: async () => ({ messageId: "unreachable" }),
    }),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    resolveArtifact: async () => ({ filePath: "/artifact/demo.mp3", fileName: "demo.mp3" }),
    stageOutboundArtifact: async () => ({
      artifact: { filePath: "/qq-outbound/demo.mp3", fileName: "demo.mp3" },
      release: async () => { releases += 1; },
    }),
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  await communication.start();

  const receipt = await communication.deliver({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-uncertain-staged-file",
    target: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    text: "新版试听",
    artifacts: [{
      schema: "rma.artifact-ref/v1",
      artifactId: `artifact:${"b".repeat(64)}`,
      kind: "audio",
      availability: "available",
      fileName: "demo.mp3",
      sha256: "b".repeat(64),
    }],
  }, new AbortController().signal);

  assert.equal(receipt.status, "uncertain");
  assert.equal(releases, 0);
  await communication.close();
});

test("NapCat communication module releases a staged artifact after a definitive private rejection", async () => {
  let releases = 0;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal: new MemoryJournal(),
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    resolveArtifact: async () => ({ filePath: "/artifact/demo.mp3", fileName: "demo.mp3" }),
    stageOutboundArtifact: async () => ({
      artifact: { filePath: "/qq-outbound/demo.mp3", fileName: "demo.mp3" },
      release: async () => { releases += 1; },
    }),
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  await communication.start();

  const receipt = await communication.deliver({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-rejected-staged-file",
    target: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    text: "新版试听",
    artifacts: [{
      schema: "rma.artifact-ref/v1",
      artifactId: `artifact:${"c".repeat(64)}`,
      kind: "audio",
      availability: "available",
      fileName: "demo.mp3",
      sha256: "c".repeat(64),
    }],
  }, new AbortController().signal);

  assert.equal(receipt.status, "rejected");
  assert.equal(releases, 1);
  await communication.close();
});

test("NapCat communication module materializes a private upload once and exposes it to later routing", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  let imports = 0;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    importAttachment: async () => {
      imports += 1;
      return {
        schema: "rma.artifact-ref/v1",
        artifactId: `artifact:${"a".repeat(64)}`,
        kind: "audio",
        availability: "available",
        fileName: "take.wav",
        bytes: 1024,
        sha256: "a".repeat(64),
      };
    },
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  const received: InboundTurn[] = [];
  communication.subscribe(async (turn) => { received.push(turn); });
  await communication.start();
  const privateMessage: QqMessage = {
    messageId: "private-upload",
    accountId: "42",
    conversation: { kind: "private", id: "7" },
    senderId: "7",
    senderName: "Singer",
    occurredAt: "2026-08-19T08:00:00.000Z",
    text: "这个是人声音轨",
    attachments: [{ kind: "audio", id: "qq-file-1", name: "take.wav" }],
  };

  await server?.options.journalMessage?.(privateMessage);
  await server?.options.processMessage(privateMessage);

  assert.equal(imports, 1);
  assert.equal(received[0]?.channel.conversation.kind, "private");
  assert.equal(received[0]?.attachments[0]?.availability, "available");
  assert.equal(received[0]?.attachments[0]?.fileName, "take.wav");
  await communication.close();
});

test("NapCat communication module marks a started external send as uncertain", async () => {
  const journal = new MemoryJournal();
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendMessage: async () => {
        throw new Error("connection reset after request write");
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
    now: () => "2026-08-19T08:03:00.000Z",
  });
  await communication.start();

  const receipt = await communication.deliver({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-uncertain",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    correlation: { sessionId: "song-1", iteration: 2 },
    text: "第 2 版已完成",
    artifacts: [],
  }, new AbortController().signal);

  assert.equal(receipt.status, "uncertain");
  assert.equal(receipt.errorCode, "RMA_DELIVERY_UNCERTAIN");
  assert.deepEqual(journal.settled, [receipt]);
});

test("NapCat communication module does not send the same delivery twice", async () => {
  const journal = new MemoryJournal();
  let sends = 0;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendMessage: async () => {
        sends += 1;
        return { messageId: "qq-result-once" };
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
    now: () => "2026-08-19T08:04:00.000Z",
  });
  await communication.start();
  const reply: OutboundMessage = {
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-once",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    correlation: { sessionId: "song-1", iteration: 3 },
    text: "只发送一次",
    artifacts: [],
  };

  const first = await communication.deliver(reply, new AbortController().signal);
  const replay = await communication.deliver(reply, new AbortController().signal);

  assert.equal(sends, 1);
  assert.deepEqual(replay, first);
});

test("NapCat communication module replays a durably accepted turn when a subscriber appears", async () => {
  const journal = new MemoryJournal();
  const pending = {
    schema: "rma.inbound-turn/v2" as const,
    idempotencyKey: "qq:42:group:314:pending",
    channel: { kind: "qq" as const, accountId: "42", conversation: { kind: "group" as const, id: "314" } },
    messageId: "pending",
    sender: { id: "7", displayName: "Singer" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: "继续上一条",
    attachments: [],
  };
  await journal.recordAccepted(pending);
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  await communication.start();
  const replayed = new Promise<InboundTurn>((resolve) => {
    communication.subscribe(async (turn) => resolve(turn));
  });

  assert.deepEqual(await replayed, pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(journal.processed.has(pending.idempotencyKey), true);
});

test("NapCat communication replay stops at a non-retryable pending handler failure", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  const pending = (messageId: string): InboundTurn => ({
    schema: "rma.inbound-turn/v2",
    idempotencyKey: `qq:42:private:7:${messageId}`,
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId,
    sender: { id: "7" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: messageId,
    attachments: [],
  });
  const poisoned = pending("poisoned");
  const healthy = pending("healthy");
  await journal.recordAccepted(poisoned);
  await journal.recordAccepted(healthy);
  const errors: unknown[] = [];
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
    onError: (error) => { errors.push(error); },
  });
  let poisonedStarted: (() => void) | undefined;
  const replayingPoisoned = new Promise<void>((resolve) => { poisonedStarted = resolve; });
  let failPoisoned: (() => void) | undefined;
  const poisonedMayFail = new Promise<void>((resolve) => { failPoisoned = resolve; });
  communication.subscribe(async (turn) => {
    if (turn.idempotencyKey === poisoned.idempotencyKey) {
      poisonedStarted?.();
      await poisonedMayFail;
      throw new Error("operator recovery required");
    }
  });

  await communication.start();
  await replayingPoisoned;

  const live = { ...groupMessage, messageId: "during-poisoned-replay", text: "恢复期间的新任务" };
  await server?.options.journalMessage?.(live);
  await server?.options.processMessage(live);
  failPoisoned?.();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(journal.processed.has(poisoned.idempotencyKey), false);
  assert.equal(journal.processed.has(healthy.idempotencyKey), false);
  assert.equal(journal.processed.has("qq:42:group:314:during-poisoned-replay"), true);
  assert.equal(errors.length, 1);

  const after = { ...groupMessage, messageId: "after-poisoned-replay", text: "新任务仍应正常处理" };
  await server?.options.journalMessage?.(after);
  await server?.options.processMessage(after);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(journal.processed.has("qq:42:group:314:after-poisoned-replay"), true);
  assert.equal(errors.length, 1);
  await communication.close();
});

test("NapCat communication module keeps rate-limited turns pending and resumes them after backoff", async () => {
  const journal = new MemoryJournal();
  const pending: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:private:7:rate-limited",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId: "rate-limited",
    sender: { id: "7" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: "继续混音",
    attachments: [],
  };
  await journal.recordAccepted(pending);
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 10,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  let attempts = 0;
  let resumed: (() => void) | undefined;
  const processed = new Promise<void>((resolve) => { resumed = resolve; });
  communication.subscribe(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new RetryableInboundError("provider rate limited", { retryAfterMs: 1 });
    }
    resumed?.();
  });

  await communication.start();
  await Promise.race([
    processed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("rate-limited turn did not resume")), 200);
    }),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
  assert.equal(journal.processed.has(pending.idempotencyKey), true);
  await communication.close();
});

test("NapCat communication module queues newer turns behind provider backpressure", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 100,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  const attempts: string[] = [];
  let release: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { release = resolve; });
  communication.subscribe(async (turn) => {
    attempts.push(turn.messageId);
    if (attempts.length === 1) {
      throw new RetryableInboundError("provider rate limited", { retryAfterMs: 30 });
    }
    if (turn.messageId === "queued-second") release?.();
  });
  await communication.start();
  const first = { ...groupMessage, messageId: "queued-first", text: "第一个任务" };
  const second = { ...groupMessage, messageId: "queued-second", text: "第二个任务" };

  await server?.options.journalMessage?.(first);
  await server?.options.processMessage(first);
  await server?.options.journalMessage?.(second);
  await server?.options.processMessage(second);
  assert.deepEqual(attempts, ["queued-first"]);

  await Promise.race([
    completed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("queued turns did not resume in order")), 300);
    }),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(attempts, ["queued-first", "queued-first", "queued-second"]);
  assert.equal((await journal.listPendingAccepted()).length, 0);
  await communication.close();
});

test("NapCat communication recovery keeps live turns behind the active replay", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 10,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  const attempts: string[] = [];
  let retryStarted: (() => void) | undefined;
  const replaying = new Promise<void>((resolve) => { retryStarted = resolve; });
  let releaseRetry: (() => void) | undefined;
  const retryMayFinish = new Promise<void>((resolve) => { releaseRetry = resolve; });
  let secondHandled: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { secondHandled = resolve; });
  communication.subscribe(async (turn) => {
    attempts.push(turn.messageId);
    if (turn.messageId === "exclusive-first" && attempts.length === 1) {
      throw new RetryableInboundError("provider rate limited", { retryAfterMs: 1 });
    }
    if (turn.messageId === "exclusive-first") {
      retryStarted?.();
      await retryMayFinish;
    } else {
      secondHandled?.();
    }
  });
  await communication.start();
  const first = { ...groupMessage, messageId: "exclusive-first", text: "先处理我" };
  const second = { ...groupMessage, messageId: "exclusive-second", text: "排在后面" };

  await server?.options.journalMessage?.(first);
  await server?.options.processMessage(first);
  await replaying;
  await server?.options.journalMessage?.(second);
  await server?.options.processMessage(second);

  assert.deepEqual(attempts, ["exclusive-first", "exclusive-first"]);
  releaseRetry?.();
  await completed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(attempts, ["exclusive-first", "exclusive-first", "exclusive-second"]);
  await communication.close();
});

test("NapCat communication module preserves provider backoff across restart", async () => {
  const journal = new MemoryJournal();
  const pending: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:group:314:restart-backoff",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    messageId: "restart-backoff",
    sender: { id: "7" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: "限流恢复后继续",
    attachments: [],
  };
  await journal.recordAccepted(pending);
  let attempts = 0;
  const first = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 100,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  let limited: (() => void) | undefined;
  const rateLimited = new Promise<void>((resolve) => { limited = resolve; });
  first.subscribe(async () => {
    attempts += 1;
    limited?.();
    throw new RetryableInboundError("provider rate limited", { retryAfterMs: 80 });
  });
  await first.start();
  await rateLimited;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await first.close();

  let resumed: (() => void) | undefined;
  const processed = new Promise<void>((resolve) => { resumed = resolve; });
  const restarted = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 100,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  restarted.subscribe(async () => {
    attempts += 1;
    resumed?.();
  });
  await restarted.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 1);

  await Promise.race([
    processed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("persisted provider backoff did not resume")), 200);
    }),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(journal.retryState, undefined);
  await restarted.close();
});

test("NapCat communication module keeps quota work paused across restart until an exact continue command", async () => {
  const journal = new MemoryJournal();
  let firstServer: FakeWebhookServer | undefined;
  const first = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => {
      firstServer = new FakeWebhookServer(options);
      return firstServer;
    },
  });
  let firstAttempted: (() => void) | undefined;
  const quotaObserved = new Promise<void>((resolve) => { firstAttempted = resolve; });
  first.subscribe(async () => {
    firstAttempted?.();
    throw new RetryableInboundError("quota exhausted", { resumePolicy: "manual" });
  });
  await first.start();
  const original = { ...groupMessage, messageId: "quota-original", text: "继续" };
  const queued = { ...groupMessage, messageId: "quota-queued", text: "再处理这条" };
  await firstServer?.options.journalMessage?.(original);
  await firstServer?.options.processMessage(original);
  await quotaObserved;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await firstServer?.options.journalMessage?.(queued);
  await firstServer?.options.processMessage(queued);
  assert.equal(journal.retryState?.resumePolicy, "manual");
  await first.close();

  let restartedServer: FakeWebhookServer | undefined;
  const restarted = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => {
      restartedServer = new FakeWebhookServer(options);
      return restartedServer;
    },
  });
  const attempts: string[] = [];
  restarted.subscribe(async (turn) => { attempts.push(turn.messageId); });
  await restarted.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts.length, 0);

  // A platform redelivery of the pre-pause task is not a new resume instruction.
  await restartedServer?.options.journalMessage?.(original);
  await restartedServer?.options.processMessage(original);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts.length, 0);
  assert.equal(journal.retryState?.resumePolicy, "manual");

  const ordinaryContinueText = { ...groupMessage, messageId: "quota-continue-mix", text: "继续混音" };
  await restartedServer?.options.journalMessage?.(ordinaryContinueText);
  await restartedServer?.options.processMessage(ordinaryContinueText);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts.length, 0);

  const continueCommand = { ...groupMessage, messageId: "quota-continue", text: "继续" };
  const duplicateContinue = { ...groupMessage, messageId: "quota-continue-duplicate", text: " 继续 " };
  await restartedServer?.options.journalMessage?.(continueCommand);
  await restartedServer?.options.journalMessage?.(duplicateContinue);
  // Simulate a crash after durable acceptance but before either process callback.
  await restarted.close();

  let completed: (() => void) | undefined;
  const drained = new Promise<void>((resolve) => { completed = resolve; });
  const recovered = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  recovered.subscribe(async (turn) => {
    attempts.push(turn.messageId);
    if (turn.messageId === "quota-continue-mix") completed?.();
  });
  await recovered.start();
  await Promise.race([
    drained,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("manual quota queue did not resume")), 200);
    }),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(attempts, ["quota-original", "quota-queued", "quota-continue-mix"]);
  assert.equal(journal.processed.has("qq:42:group:314:quota-continue"), true);
  assert.equal(journal.processed.has("qq:42:group:314:quota-continue-duplicate"), true);
  assert.equal(journal.retryState, undefined);
  await recovered.close();
});

test("NapCat communication module restores provider backoff before accepting startup traffic", async () => {
  const journal = new MemoryJournal();
  journal.retryState = { notBefore: Date.now() + 100, attempts: 2 };
  let attempts = 0;
  const startupMessage = { ...groupMessage, messageId: "during-startup-backoff", text: "启动时到达" };
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 100,
    createWebhookServer: (options) => ({
      start: async () => {
        await options.journalMessage?.(startupMessage);
        await options.processMessage(startupMessage);
        assert.equal(attempts, 0);
        return { host: "127.0.0.1", port: 32180 };
      },
      close: async () => {},
    }),
  });
  communication.subscribe(async () => { attempts += 1; });

  await communication.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assert.equal(attempts, 0);
  assert.equal((await journal.listPendingAccepted()).length, 1);
  await communication.close();
});

test("NapCat communication module preserves Retry-After beyond one Node timer interval", async () => {
  const journal = new MemoryJournal();
  let server: FakeWebhookServer | undefined;
  const retryAfterMs = 2_147_483_647 + 60_000;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 100,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  communication.subscribe(async () => {
    throw new RetryableInboundError("provider rate limited", { retryAfterMs });
  });
  await communication.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = Date.now();
  const message = { ...groupMessage, messageId: "long-retry-after", text: "长时间限流" };

  await server?.options.journalMessage?.(message);
  await server?.options.processMessage(message);

  assert.ok(journal.retryState);
  assert.ok(journal.retryState.notBefore >= before + retryAfterMs);
  await communication.close();
});

test("NapCat communication module resolves pending inbox with an unavailable reply in QQ-only mode", async () => {
  const journal = new MemoryJournal();
  const pending = {
    schema: "rma.inbound-turn/v2" as const,
    idempotencyKey: "qq:42:group:314:qq-only-pending",
    channel: { kind: "qq" as const, accountId: "42", conversation: { kind: "group" as const, id: "314" } },
    messageId: "qq-only-pending",
    sender: { id: "7", displayName: "Singer" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: "有人在吗",
    attachments: [],
  };
  await journal.recordAccepted(pending);
  const sent: string[] = [];
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendMessage: async (request) => {
        sent.push(request.message);
        return { messageId: "unavailable-after-restart" };
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });

  await communication.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(sent, ["混音能力当前不可用，请稍后重试。"]);
  assert.equal(journal.processed.has(pending.idempotencyKey), true);
});

test("NapCat communication module keeps pending inbox until the DSH conversation subscriber is ready", async () => {
  const journal = new MemoryJournal();
  const pending: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:private:7:startup-race",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId: "startup-race",
    sender: { id: "7" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: "启动时不要丢掉我",
    attachments: [],
  };
  await journal.recordAccepted(pending);
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    allowedPrivateUserIds: ["7"],
    replyWhenUnavailable: false,
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });

  await communication.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(journal.processed.has(pending.idempotencyKey), false);

  const replayed = new Promise<InboundTurn>((resolve) => {
    communication.subscribe(async (turn) => { resolve(turn); });
  });
  assert.deepEqual(await replayed, pending);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(journal.processed.has(pending.idempotencyKey), true);
  await communication.close();
});

test("NapCat communication module waits for accepted replay work before closing", async () => {
  const journal = new MemoryJournal();
  const pending = {
    schema: "rma.inbound-turn/v2" as const,
    idempotencyKey: "qq:42:group:314:closing-pending",
    channel: { kind: "qq" as const, accountId: "42", conversation: { kind: "group" as const, id: "314" } },
    messageId: "closing-pending",
    sender: { id: "7", displayName: "Singer" },
    occurredAt: "2026-08-19T08:05:00.000Z",
    text: "关闭前处理我",
    attachments: [],
  };
  await journal.recordAccepted(pending);
  let releaseHandler: (() => void) | undefined;
  const handlerStarted = new Promise<void>((resolveStarted) => {
    releaseHandler = resolveStarted;
  });
  let finishHandler: (() => void) | undefined;
  const handlerMayFinish = new Promise<void>((resolveFinish) => {
    finishHandler = resolveFinish;
  });
  const communication = new NapCatCommunicationModule({
    gateway: createGateway(),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  communication.subscribe(async () => {
    releaseHandler?.();
    await handlerMayFinish;
  });
  await communication.start();
  await handlerStarted;

  let closed = false;
  const closing = communication.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);

  finishHandler?.();
  await closing;
  assert.equal(journal.processed.has(pending.idempotencyKey), true);
});

test("NapCat communication module explicitly replies when no mixing subscriber is loaded", async () => {
  const journal = new MemoryJournal();
  const sent: string[] = [];
  let server: FakeWebhookServer | undefined;
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendMessage: async (request) => {
        sent.push(request.message);
        return { messageId: "unavailable-1" };
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => {
      server = new FakeWebhookServer(options);
      return server;
    },
  });
  await communication.start();

  await server?.options.journalMessage?.(groupMessage);
  await server?.options.processMessage(groupMessage);

  assert.deepEqual(sent, ["混音能力当前不可用，请稍后重试。"]);
  assert.equal(journal.processed.has("qq:42:group:314:9001"), true);
});

test("NapCat communication module preserves a definitive OneBot rejection", async () => {
  const journal = new MemoryJournal();
  const communication = new NapCatCommunicationModule({
    gateway: createGateway({
      sendMessage: async () => {
        throw new OneBotActionError("rejected", "group rejected the message");
      },
    }),
    journal,
    accountId: "42",
    groupId: "314",
    host: "127.0.0.1",
    port: 32180,
    createWebhookServer: (options) => new FakeWebhookServer(options),
  });
  await communication.start();

  const receipt = await communication.deliver({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-rejected",
    settlesInboundIdempotencyKey: "qq:42:group:314:rejected-source",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    correlation: { sessionId: "song-1", iteration: 4 },
    text: "不会发出",
    artifacts: [],
  }, new AbortController().signal);

  assert.equal(receipt.status, "rejected");
  assert.equal(receipt.errorCode, "RMA_DELIVERY_REJECTED");
  assert.equal(journal.processed.has("qq:42:group:314:rejected-source"), true);
});

test("delivery settlement atomically removes its inbound turn from restart replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-settlement-"));
  const path = join(root, "events.jsonl");
  const pending: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:private:7:atomic-rejected",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId: "atomic-rejected",
    sender: { id: "7" },
    occurredAt: "2026-08-20T08:06:00.000Z",
    text: "渲染一版",
    attachments: [],
  };
  const journal = new JsonlCommunicationJournal(path, () => "2026-08-20T08:06:01.000Z");
  await journal.recordAccepted(pending);
  await journal.recordSettled({
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivery-atomic-rejected",
    status: "rejected",
    occurredAt: "2026-08-20T08:06:02.000Z",
    errorCode: "RMA_DELIVERY_REJECTED",
  }, pending.idempotencyKey);

  const restarted = new JsonlCommunicationJournal(path);
  assert.deepEqual(await restarted.listPendingAccepted(), []);
  assert.deepEqual(await restarted.findDelivery("delivery-atomic-rejected"), {
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivery-atomic-rejected",
    status: "rejected",
    occurredAt: "2026-08-20T08:06:02.000Z",
    errorCode: "RMA_DELIVERY_REJECTED",
  });
});

test("an uncertain settlement keeps the inbound replayable until its projection succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-uncertain-projection-"));
  const path = join(root, "events.jsonl");
  const pending: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:private:7:uncertain-projection",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId: "uncertain-projection",
    sender: { id: "7" },
    occurredAt: "2026-08-20T08:07:00.000Z",
    text: "渲染一版",
    attachments: [],
  };
  const journal = new JsonlCommunicationJournal(path, () => "2026-08-20T08:07:01.000Z");
  await journal.recordAccepted(pending);
  await journal.recordSettled({
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivery-uncertain-projection",
    status: "uncertain",
    occurredAt: "2026-08-20T08:07:02.000Z",
    errorCode: "RMA_DELIVERY_UNCERTAIN",
  }, pending.idempotencyKey);

  assert.deepEqual((await new JsonlCommunicationJournal(path).listPendingAccepted())
    .map((turn) => turn.idempotencyKey), [pending.idempotencyKey]);
  await journal.recordProcessed(pending.idempotencyKey);
  assert.deepEqual(await new JsonlCommunicationJournal(path).listPendingAccepted(), []);
});

test("communication journal reopens a mistakenly processed inbound without rewriting history", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-reopen-"));
  const path = join(root, "events.jsonl");
  const first: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:private:7:disposed",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId: "disposed",
    sender: { id: "7" },
    occurredAt: "2026-08-24T14:01:00.000Z",
    text: "继续呢",
    attachments: [],
  };
  const second: InboundTurn = {
    ...first,
    idempotencyKey: "qq:42:private:7:disposed-2",
    messageId: "disposed-2",
    occurredAt: "2026-08-24T14:02:00.000Z",
    text: "你改的版本对应哪条消息？",
  };
  const journal = new JsonlCommunicationJournal(path, () => "2026-08-24T14:05:00.000Z");
  await journal.recordAccepted(first);
  await journal.recordAccepted(second);
  await journal.recordProcessed(first.idempotencyKey);
  await journal.recordProcessed(second.idempotencyKey);
  assert.deepEqual(await journal.listPendingAccepted(), []);

  await journal.reopenProcessed([second.idempotencyKey, first.idempotencyKey]);
  assert.deepEqual(await new JsonlCommunicationJournal(path).listPendingAccepted(), [first, second]);

  await journal.recordProcessed(first.idempotencyKey);
  assert.deepEqual(await new JsonlCommunicationJournal(path).listPendingAccepted(), [second]);
});

test("communication journal only reopens effective processed events", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-reopen-guards-"));
  const path = join(root, "events.jsonl");
  const base: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:private:7:base",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
    messageId: "base",
    sender: { id: "7" },
    occurredAt: "2026-08-24T14:01:00.000Z",
    text: "base",
    attachments: [],
  };
  const delivered = { ...base, idempotencyKey: "qq:42:private:7:delivered", messageId: "delivered" };
  const resume = { ...base, idempotencyKey: "qq:42:private:7:resume", messageId: "resume", text: "继续" };
  const pending = { ...base, idempotencyKey: "qq:42:private:7:pending", messageId: "pending" };
  const journal = new JsonlCommunicationJournal(path, () => "2026-08-24T14:05:00.000Z");

  await assert.rejects(journal.reopenProcessed(["qq:42:private:7:unknown"]), /unknown inbound/u);
  await journal.recordAccepted(delivered);
  await journal.recordProcessed(delivered.idempotencyKey);
  await journal.recordSettled({
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivered-reply",
    status: "delivered",
    occurredAt: "2026-08-24T14:05:00.000Z",
  }, delivered.idempotencyKey);
  await assert.rejects(journal.reopenProcessed([delivered.idempotencyKey]), /settled delivery/u);

  await journal.recordRetryState({ notBefore: 0, attempts: 1, resumePolicy: "manual" });
  await journal.recordAccepted(resume);
  assert.equal(await journal.consumeManualResumeCommands("继续"), true);
  await assert.rejects(journal.reopenProcessed([resume.idempotencyKey]), /retry control/u);

  await journal.recordAccepted(pending);
  await assert.rejects(journal.reopenProcessed([pending.idempotencyKey]), /effective processed event/u);
});

test("JSONL communication journal preserves pending inbox and delivery idempotency state after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-"));
  const path = join(root, "events.jsonl");
  const turn: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:group:314:persisted",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    messageId: "persisted",
    sender: { id: "7" },
    occurredAt: "2026-08-19T08:06:00.000Z",
    text: "持久化",
    attachments: [],
  };
  const first = new JsonlCommunicationJournal(path, () => "2026-08-19T08:06:01.000Z");
  await Promise.all([first.recordAccepted(turn), first.recordAccepted(turn)]);

  const restarted = new JsonlCommunicationJournal(path, () => "2026-08-19T08:06:02.000Z");
  assert.deepEqual(await restarted.listPendingAccepted(), [turn]);
  await restarted.recordAttempting({
    schema: "rma.outbound-message/v1",
    deliveryId: "persisted-delivery",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    correlation: { sessionId: "song-1", iteration: 1 },
    text: "发送中",
    artifacts: [],
  });
  assert.equal(await new JsonlCommunicationJournal(path).findDelivery("persisted-delivery"), "attempting");

  const receipt: DeliveryReceipt = {
    schema: "rma.delivery-receipt/v1",
    deliveryId: "persisted-delivery",
    status: "delivered",
    platformMessageId: "qq-88",
    occurredAt: "2026-08-19T08:06:03.000Z",
  };
  await restarted.recordSettled(receipt);
  await restarted.recordProcessed(turn.idempotencyKey);

  const completed = new JsonlCommunicationJournal(path);
  assert.deepEqual(await completed.listPendingAccepted(), []);
  assert.deepEqual(await completed.findDelivery("persisted-delivery"), receipt);
  assert.equal(await completed.hasDeliveredPlatformMessage(
    { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    "qq-88",
  ), true);
  assert.equal(await completed.hasDeliveredPlatformMessage(
    { kind: "qq", accountId: "42", conversation: { kind: "group", id: "999" } },
    "qq-88",
  ), false);
  assert.equal(await completed.hasDeliveredPlatformMessage(
    { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    "not-from-the-bot",
  ), false);
});

test("JSONL communication journal preserves and clears provider retry state", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-retry-state-"));
  const path = join(root, "events.jsonl");
  const journal = new JsonlCommunicationJournal(path, () => "2026-08-24T08:00:00.000Z");
  const retryState = { notBefore: 0, attempts: 3, resumePolicy: "manual" as const };
  const continueTurn: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:group:314:continue-quota",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    messageId: "continue-quota",
    sender: { id: "7" },
    occurredAt: "2026-08-24T08:00:00.000Z",
    text: "继续",
    attachments: [],
  };
  const originalContinue = {
    ...continueTurn,
    idempotencyKey: "qq:42:group:314:original-continue",
    messageId: "original-continue",
  };

  await journal.recordAccepted(originalContinue);
  await journal.recordRetryState(retryState);
  await journal.recordAccepted(continueTurn);
  assert.deepEqual(await new JsonlCommunicationJournal(path).readRetryState(), retryState);

  const duplicateContinue = { ...continueTurn, idempotencyKey: "qq:42:group:314:continue-quota-2" };
  await journal.recordAccepted(duplicateContinue);
  assert.equal(await new JsonlCommunicationJournal(path).consumeManualResumeCommands("继续"), true);
  assert.equal(await new JsonlCommunicationJournal(path).readRetryState(), undefined);
  assert.deepEqual(await new JsonlCommunicationJournal(path).listPendingAccepted(), [originalContinue]);
});

test("communication journal reconciles an uncertain delivery in its authoritative transport log", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-communication-reconcile-"));
  const path = join(root, "events.jsonl");
  const journal = new JsonlCommunicationJournal(path, () => "2026-08-21T02:00:00.000Z");
  const inbound: InboundTurn = {
    schema: "rma.inbound-turn/v2",
    idempotencyKey: "qq:42:group:314:reconcile",
    channel: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    messageId: "reconcile",
    sender: { id: "7" },
    occurredAt: "2026-08-21T01:59:00.000Z",
    text: "发群里",
    attachments: [],
  };
  await journal.recordAccepted(inbound);
  await journal.recordAttempting({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-reconcile",
    settlesInboundIdempotencyKey: inbound.idempotencyKey,
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    text: "第 1 版",
    artifacts: [],
  });
  await journal.recordSettled({
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivery-reconcile",
    status: "uncertain",
    occurredAt: "2026-08-21T02:00:00.000Z",
    errorCode: "RMA_DELIVERY_UNCERTAIN",
  });

  const receipt = await journal.reconcileDelivery({
    deliveryId: "delivery-reconcile",
    accountId: "42",
    groupId: "314",
    outcome: "delivered",
    platformMessageId: "qq-confirmed-1",
  });

  assert.equal(receipt.status, "delivered");
  assert.equal(receipt.platformMessageId, "qq-confirmed-1");
  assert.deepEqual(await new JsonlCommunicationJournal(path).listPendingAccepted(), []);
  assert.deepEqual(await new JsonlCommunicationJournal(path).findDelivery("delivery-reconcile"), receipt);
  await assert.rejects(journal.reconcileDelivery({
    deliveryId: "delivery-reconcile",
    accountId: "42",
    groupId: "999",
    outcome: "abandoned",
  }), /outside the configured QQ account or group/u);
});
