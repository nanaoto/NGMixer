import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { normalizeOneBotEvent, normalizeOneBotMessage } from "../src/qq/onebot.js";
import { OneBotWebhookServer } from "../src/qq/webhook-server.js";

test("OneBot webhook accepts a group event and queues it for mixing without blocking the response", async () => {
  const processed: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    processMessage: async (message) => {
      processed.push(message.text);
    },
    journalMessage: async (message) => {
      processed.push(`journal:${message.messageId}`);
    },
  });
  const response = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: {
        time: 1_787_078_400,
        post_type: "message",
        message_type: "group",
        message_id: 123,
        group_id: 456,
        user_id: 789,
        raw_message: "主唱靠前一点",
        message: [{ type: "text", data: { text: "主唱靠前一点" } }],
    },
  });

  assert.equal(response.status, 202);
  await server.drain();
  assert.deepEqual(processed, ["journal:123", "主唱靠前一点"]);
});

test("OneBot webhook rejects requests carrying the wrong secret", async () => {
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    webhookToken: "expected",
    processMessage: async () => undefined,
  });
  const response = await server.accept({
    method: "POST",
    path: "/onebot/events",
    authorization: "Bearer wrong",
    body: {},
  });
  assert.equal(response.status, 401);
});

test("OneBot webhook accepts an allowlisted private offline-file notice", async () => {
  const accepted: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", allowedPrivateUserIds: ["789"] },
    normalizeMessage: normalizeOneBotEvent,
    processMessage: async (message) => { accepted.push(message.attachments[0]?.id ?? "missing"); },
  });
  const response = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_402,
      self_id: 42,
      post_type: "notice",
      notice_type: "offline_file",
      user_id: 789,
      file: { id: "offline-f1", name: "stems.zip", size: 4096 },
    },
  });

  assert.equal(response.status, 202);
  await server.drain();
  assert.deepEqual(accepted, ["offline-f1"]);
});

test("OneBot webhook ignores an allowlisted private event with no text or supported attachments", async () => {
  const accepted: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", allowedPrivateUserIds: ["789"] },
    normalizeMessage: normalizeOneBotEvent,
    journalMessage: async (message) => { accepted.push(`journal:${message.messageId}`); },
    processMessage: async (message) => { accepted.push(`process:${message.messageId}`); },
  });
  const response = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_403,
      self_id: 42,
      post_type: "message",
      message_type: "private",
      message_id: 48429224,
      user_id: 789,
      raw_message: "",
      message: [],
      sender: { user_id: 789, nickname: "Singer" },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ignored, true);
  await server.drain();
  assert.deepEqual(accepted, []);
});

test("OneBot webhook ignores a private self-message even when the peer id is allowlisted", async () => {
  const accepted: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", allowedPrivateUserIds: ["789"] },
    normalizeMessage: normalizeOneBotEvent,
    journalMessage: async (message) => { accepted.push(`journal:${message.messageId}`); },
    processMessage: async (message) => { accepted.push(`process:${message.messageId}`); },
  });
  const response = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_404,
      self_id: 42,
      post_type: "message",
      message_type: "private",
      message_sent_type: "self",
      target_id: 789,
      message_id: 1833316706,
      user_id: 789,
      raw_message: "新版试听",
      message: [{ type: "text", data: { text: "新版试听" } }],
      sender: { user_id: 42, nickname: "mix-bot" },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ignored, true);
  await server.drain();
  assert.deepEqual(accepted, []);
});

test("OneBot webhook refuses startup when its lifecycle is already aborted", async () => {
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    processMessage: async () => undefined,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(server.start(controller.signal), { name: "AbortError" });
  await assert.doesNotReject(server.close());
});

test("OneBot webhook accepts the HMAC signature emitted by a NapCat HTTP client", async (context) => {
  const token = "expected";
  const processed: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    webhookToken: token,
    personalAccountScope: { accountId: "42", allowedPrivateUserIds: ["789"] },
    normalizeMessage: normalizeOneBotMessage,
    processMessage: async (message) => { processed.push(message.text); },
  });
  context.after(async () => { await server.close(); });
  const address = await server.start();
  const rawBody = JSON.stringify({
    time: 1_787_223_275,
    self_id: 42,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 755675158,
    user_id: 789,
    raw_message: "hello能看到消息吗",
    message: [{ type: "text", data: { text: "hello能看到消息吗" } }],
  });
  const signature = `sha1=${createHmac("sha1", token).update(rawBody).digest("hex")}`;

  const tampered = await fetch(`http://${address.host}:${address.port}/onebot/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: rawBody.replace("hello能看到消息吗", "tampered"),
  });
  const response = await fetch(`http://${address.host}:${address.port}/onebot/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: rawBody,
  });

  assert.equal(tampered.status, 401);
  assert.equal(response.status, 202);
  await server.drain();
  assert.deepEqual(processed, ["hello能看到消息吗"]);
});

test("OneBot webhook returns 429 before durable acceptance when its bounded queue is full", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const journaled: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    maxPendingTotal: 1,
    maxPendingPerQueue: 1,
    journalMessage: async (message) => { journaled.push(message.messageId); },
    processMessage: async () => blocked,
  });
  const event = (messageId: number) => ({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_400,
      post_type: "message",
      message_type: "group",
      message_id: messageId,
      group_id: 456,
      user_id: 789,
      raw_message: "test",
      message: [{ type: "text", data: { text: "test" } }],
    },
  });

  assert.equal((await server.accept(event(1))).status, 202);
  const busy = await server.accept(event(2));
  assert.equal(busy.status, 429);
  assert.deepEqual(journaled, ["1"]);
  release();
  await server.drain();
});

test("OneBot webhook serializes different groups that share one REAPER session", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    processMessage: async (message) => {
      order.push(`start:${message.groupId}`);
      if (message.groupId === "1") await firstBlocked;
      order.push(`end:${message.groupId}`);
    },
  });
  const event = (messageId: number, groupId: number) => ({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_400,
      post_type: "message",
      message_type: "group",
      message_id: messageId,
      group_id: groupId,
      user_id: 789,
      raw_message: "主唱靠前",
      message: [{ type: "text", data: { text: "主唱靠前" } }],
    },
  });

  await server.accept(event(1, 1));
  await server.accept(event(2, 2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["start:1"]);
  releaseFirst();
  await server.drain();
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2"]);
});

test("NapCat personal-account scope passively observes unmentioned group messages without processing them", async () => {
  const processed: string[] = [];
  const observed: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", groupId: "456" },
    normalizeMessage: (input) => {
      const body = input as { message_id: number; message: Array<{ type: string; data: { text?: string } }> };
      return {
        messageId: String(body.message_id),
        text: body.message.filter((s) => s.type === "text").map((s) => s.data.text ?? "").join(""),
      };
    },
    observeMessage: async (message) => { observed.push(message.text); },
    processMessage: async (message) => { processed.push(message.messageId); },
  });
  const event = (messageId: number, mention?: string) => ({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_400,
      self_id: 42,
      post_type: "message",
      message_type: "group",
      message_id: messageId,
      group_id: 456,
      user_id: 789,
      raw_message: "这里好糊",
      message: [
        ...(mention ? [{ type: "at", data: { qq: mention } }] : []),
        { type: "text", data: { text: "这里好糊" } },
      ],
    },
  });

  const unmentioned = await server.accept(event(1));
  const mentionedBot = await server.accept(event(2, "42"));

  assert.equal(unmentioned.status, 200);
  assert.equal(unmentioned.body.observed, true);
  assert.equal(unmentioned.body.ignored, undefined);
  assert.equal(mentionedBot.status, 202);
  await server.drain();
  assert.deepEqual(observed, ["这里好糊"]);
  assert.deepEqual(processed, ["2"]);
});

test("NapCat personal-account scope accepts group messages only when they mention the bot account", async () => {
  const processed: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", groupId: "456" },
    processMessage: async (message) => { processed.push(message.messageId); },
  });
  const event = (messageId: number, mention?: string) => ({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_400,
      self_id: 42,
      post_type: "message",
      message_type: "group",
      message_id: messageId,
      group_id: 456,
      user_id: 789,
      raw_message: "主唱靠前",
      message: [
        ...(mention ? [{ type: "at", data: { qq: mention } }] : []),
        { type: "text", data: { text: "主唱靠前" } },
      ],
    },
  });

  const unmentioned = await server.accept(event(1));
  const mentionedSomeoneElse = await server.accept(event(2, "99"));
  const mentionedBot = await server.accept(event(3, "42"));

  assert.deepEqual(
    [unmentioned.status, mentionedSomeoneElse.status, mentionedBot.status],
    [200, 200, 202],
  );
  assert.equal(unmentioned.body.ignored, true);
  assert.equal(mentionedSomeoneElse.body.ignored, true);
  await server.drain();
  assert.deepEqual(processed, ["3"]);
});

test("NapCat personal-account scope accepts an unmentioned group message when it replies to the bot", async () => {
  const processed: string[] = [];
  const checkedReplies: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", groupId: "456" },
    isReplyToBot: async ({ messageId }) => {
      checkedReplies.push(messageId);
      return messageId === "bot-message";
    },
    processMessage: async (message) => { processed.push(message.messageId); },
  });
  const event = (messageId: number, replyToMessageId: string) => ({
    method: "POST",
    path: "/onebot/events",
    body: {
      time: 1_787_078_400,
      self_id: 42,
      post_type: "message",
      message_type: "group",
      message_id: messageId,
      group_id: 456,
      user_id: 789,
      raw_message: "再来一点",
      message: [
        { type: "reply", data: { id: replyToMessageId } },
        { type: "text", data: { text: "再来一点" } },
      ],
    },
  });

  const repliedToMember = await server.accept(event(4, "member-message"));
  const repliedToBot = await server.accept(event(5, "bot-message"));

  assert.deepEqual([repliedToMember.status, repliedToBot.status], [200, 202]);
  assert.equal(repliedToMember.body.ignored, true);
  await server.drain();
  assert.deepEqual(checkedReplies, ["member-message", "bot-message"]);
  assert.deepEqual(processed, ["5"]);
});

test("NapCat personal-account scope ignores meta events, self messages, and other groups", async () => {
  const processed: string[] = [];
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: { accountId: "42", groupId: "456" },
    processMessage: async (message) => { processed.push(message.messageId); },
  });
  const base = {
    time: 1_787_078_400,
    self_id: 42,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 123,
    group_id: 456,
    user_id: 789,
    raw_message: "主唱靠前",
    message: [
      { type: "at", data: { qq: "42" } },
      { type: "text", data: { text: "主唱靠前" } },
    ],
  };

  const meta = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: { time: base.time, self_id: 42, post_type: "meta_event", meta_event_type: "heartbeat" },
  });
  const self = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: { ...base, user_id: 42 },
  });
  const otherGroup = await server.accept({
    method: "POST",
    path: "/onebot/events",
    body: { ...base, group_id: 999 },
  });
  const target = await server.accept({ method: "POST", path: "/onebot/events", body: base });

  assert.deepEqual([meta.status, self.status, otherGroup.status, target.status], [200, 200, 200, 202]);
  assert.equal(meta.body.ignored, true);
  assert.equal(self.body.ignored, true);
  assert.equal(otherGroup.body.ignored, true);
  await server.drain();
  assert.deepEqual(processed, ["123"]);
});

test("OneBot webhook preserves order per conversation while private and group conversations run concurrently", async () => {
  const order: string[] = [];
  let releasePrivate!: () => void;
  const privateBlocked = new Promise<void>((resolve) => { releasePrivate = resolve; });
  const server = new OneBotWebhookServer({
    host: "127.0.0.1",
    port: 0,
    personalAccountScope: {
      accountId: "42",
      allowedGroupIds: ["456"],
      allowedPrivateUserIds: ["789"],
    },
    normalizeMessage: normalizeOneBotMessage,
    queueKey: (message) => `${message.conversation.kind}:${message.conversation.id}`,
    processMessage: async (message) => {
      order.push(`start:${message.messageId}`);
      if (message.messageId === "1") await privateBlocked;
      order.push(`end:${message.messageId}`);
    },
  });
  const body = (messageId: number, messageType: "private" | "group") => ({
    time: 1_787_078_400,
    self_id: 42,
    post_type: "message",
    message_type: messageType,
    message_id: messageId,
    ...(messageType === "group" ? { group_id: 456 } : {}),
    user_id: 789,
    raw_message: "test",
    message: [
      ...(messageType === "group" ? [{ type: "at", data: { qq: "42" } }] : []),
      { type: "text", data: { text: "test" } },
    ],
  });

  await server.accept({ method: "POST", path: "/onebot/events", body: body(1, "private") });
  await server.accept({ method: "POST", path: "/onebot/events", body: body(2, "private") });
  await server.accept({ method: "POST", path: "/onebot/events", body: body(3, "group") });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["start:1", "start:3", "end:3"]);
  releasePrivate();
  await server.drain();
  assert.deepEqual(order, ["start:1", "start:3", "end:3", "end:1", "start:2", "end:2"]);
});
