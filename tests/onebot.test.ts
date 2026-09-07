import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OneBotActionError,
  OneBotHttpGateway,
  OneBotVerificationError,
  normalizeOneBotMessage,
  normalizeOneBotGroupMessage,
  normalizeOneBotEvent,
} from "../src/qq/onebot.js";
test("normalizeOneBotGroupMessage keeps text, audio, file, and reply identity", () => {
  const message = normalizeOneBotGroupMessage({
    time: 1_787_078_400,
    self_id: 42,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 123,
    group_id: 456,
    user_id: 789,
    raw_message: "主唱亮一点",
    message: [
      { type: "reply", data: { id: "122" } },
      { type: "text", data: { text: "主唱亮一点" } },
      { type: "file", data: { file: "vocal.wav", file_id: "f1", url: "https://example.invalid/f1" } },
    ],
    sender: { nickname: "Singer" },
  });

  assert.equal(message.groupId, "456");
  assert.equal(message.accountId, "42");
  assert.equal(message.text, "主唱亮一点");
  assert.equal(message.replyToMessageId, "122");
  assert.equal(message.attachments[0]?.kind, "file");
});

test("normalizeOneBotMessage keeps image segments as downloadable file attachments", () => {
  const message = normalizeOneBotMessage({
    time: 1_787_078_403,
    self_id: 42,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 126,
    user_id: 789,
    raw_message: "[图片]",
    message: [
      { type: "text", data: { text: "看面板" } },
      { type: "image", data: { file: "panel.jpg", url: "http://127.0.0.1:3000/download/panel.jpg" } },
    ],
    sender: { nickname: "Singer" },
  });

  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0]?.kind, "file");
  assert.equal(message.attachments[0]?.name, "panel.jpg");
  // data.file is a display name, not a get_file id — images must go through url download.
  assert.equal(message.attachments[0]?.id, undefined);
  assert.equal(message.attachments[0]?.url, "http://127.0.0.1:3000/download/panel.jpg");
});

test("normalizeOneBotMessage preserves private and group conversation identity", () => {
  const privateMessage = normalizeOneBotMessage({
    time: 1_787_078_400,
    self_id: 42,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 124,
    user_id: 789,
    raw_message: "把这个发到工作群",
    message: [
      { type: "text", data: { text: "把这个发到工作群" } },
      { type: "file", data: { file: "vocal.wav", file_id: "private-f1", file_size: "2048" } },
    ],
    sender: { nickname: "Singer" },
  });
  const groupMessage = normalizeOneBotMessage({
    time: 1_787_078_401,
    self_id: 42,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 125,
    group_id: 456,
    user_id: 789,
    raw_message: "收到",
    message: [{ type: "text", data: { text: "收到" } }],
    sender: { card: "Singer" },
  });

  assert.deepEqual(privateMessage.conversation, { kind: "private", id: "789" });
  assert.equal(privateMessage.attachments[0]?.id, "private-f1");
  assert.equal(privateMessage.attachments[0]?.bytes, 2048);
  assert.deepEqual(groupMessage.conversation, { kind: "group", id: "456" });
});

test("normalizeOneBotEvent turns a NapCat offline-file notice into a private attachment turn", () => {
  const message = normalizeOneBotEvent({
    time: 1_787_078_402,
    self_id: 42,
    post_type: "notice",
    notice_type: "offline_file",
    user_id: 789,
    file: { id: "offline-f1", name: "stems.zip", size: "4096", url: "https://example.invalid/f1" },
  });

  assert.equal(message.messageId, "offline-file:offline-f1");
  assert.deepEqual(message.conversation, { kind: "private", id: "789" });
  assert.deepEqual(message.attachments, [{
    kind: "file",
    id: "offline-f1",
    name: "stems.zip",
    url: "https://example.invalid/f1",
    bytes: 4096,
  }]);
});

test("OneBotHttpGateway uploads a demo then posts a traceable group message", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as unknown });
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 999 } }), { status: 200 });
  });

  const delivery = await gateway.sendDemo({
    groupId: "456",
    filePath: "/tmp/session-1-r2.wav",
    fileName: "session-1-r2.wav",
    message: "第 2 轮 demo，请直接回复这条消息给反馈。",
  });

  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/upload_group_file",
    "http://127.0.0.1:3000/send_group_msg",
  ]);
  assert.equal(delivery.messageId, "999");
});

test("OneBotHttpGateway routes text and files to private or group conversations", async () => {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (input, init) => {
    calls.push({
      action: String(input).split("/").at(-1) ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: "sent-1" } }), {
      status: 200,
    });
  });

  await gateway.sendConversationMessage({
    target: { kind: "private", id: "789" },
    message: "私聊回复",
    replyToMessageId: "source-123",
  });
  await gateway.sendConversationFile({
    target: { kind: "group", id: "456" },
    filePath: "/tmp/demo.wav",
    fileName: "demo.wav",
  });

  assert.deepEqual(calls, [
    { action: "send_private_msg", body: {
      user_id: "789",
      message: [
        { type: "reply", data: { id: "source-123" } },
        { type: "text", data: { text: "私聊回复" } },
      ],
    } },
    { action: "upload_group_file", body: { group_id: "456", file: "/tmp/demo.wav", name: "demo.wav" } },
  ]);
});

test("OneBotHttpGateway can upload a file as a NapCat base64 resource", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rma-onebot-base64-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "demo.mp3");
  await writeFile(filePath, Buffer.from([0, 1, 2, 253, 254, 255]));
  const calls: Array<Record<string, unknown>> = [];
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ status: "ok", retcode: 0, data: {} });
  }, undefined, "base64");

  await gateway.sendConversationFile({
    target: { kind: "private", id: "789" },
    filePath,
    fileName: "demo.mp3",
  });

  assert.deepEqual(calls, [{
    user_id: "789",
    file: "base64://AAEC/f7/",
    name: "demo.mp3",
  }]);
});

test("OneBotHttpGateway resolves a received attachment through NapCat get_file", async () => {
  const calls: Array<{ action: string; body: Record<string, unknown> }> = [];
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (input, init) => {
    calls.push({
      action: new URL(String(input)).pathname.slice(1),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({
      status: "ok",
      retcode: 0,
      data: { file: "/tmp/napcat/take.wav", file_name: "take.wav", file_size: 4096 },
    });
  });

  const resolved = await gateway.resolveAttachment("file-123");

  assert.deepEqual(calls, [{ action: "get_file", body: { file_id: "file-123" } }]);
  assert.deepEqual(resolved, {
    filePath: "/tmp/napcat/take.wav",
    fileName: "take.wav",
    bytes: 4096,
  });
});

test("OneBotHttpGateway distinguishes a definitive rejection from an uncertain transport result", async () => {
  const rejected = new OneBotHttpGateway("http://127.0.0.1:3000", async () =>
    new Response(JSON.stringify({ status: "failed", retcode: 100, message: "group blocked" }), { status: 200 }));
  const uncertain = new OneBotHttpGateway("http://127.0.0.1:3000", async () => {
    throw new TypeError("connection reset");
  });

  await assert.rejects(rejected.sendMessage({ groupId: "456", message: "test" }), (error) =>
    error instanceof OneBotActionError && error.outcome === "rejected");
  await assert.rejects(uncertain.sendMessage({ groupId: "456", message: "test" }), (error) =>
    error instanceof OneBotActionError && error.outcome === "uncertain");
});

test("OneBotHttpGateway treats a rejected caption after file upload as uncertain", async () => {
  let calls = 0;
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ status: "ok", retcode: 0, data: {} }), { status: 200 })
      : new Response(JSON.stringify({ status: "failed", retcode: 100, message: "caption blocked" }), { status: 200 });
  });

  await assert.rejects(gateway.sendDemo({
    groupId: "456",
    filePath: "/tmp/session-1-r2.wav",
    fileName: "session-1-r2.wav",
    message: "第 2 轮 demo",
  }), (error) => error instanceof OneBotActionError && error.outcome === "uncertain");
});

test("NapCat gateway verifies the logged-in personal account, online state, and target group", async () => {
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (input, init) => {
    const action = String(input).split("/").at(-1);
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)) as unknown,
    });
    const data = action === "get_login_info"
      ? { user_id: "42", nickname: "Mix Account" }
      : action === "get_status"
        ? { online: true, good: true }
        : { group_id: "456", group_name: "Mix Feedback" };
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data }), { status: 200 });
  }, "secret");

  const verified = await gateway.verifyPersonalAccount({ accountId: "42", groupId: "456" });

  assert.deepEqual(verified, {
    accountId: "42",
    nickname: "Mix Account",
    online: true,
    good: true,
    groupId: "456",
    groupName: "Mix Feedback",
  });
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:3000/get_login_info",
    "http://127.0.0.1:3000/get_status",
    "http://127.0.0.1:3000/get_group_info",
  ]);
  assert.equal(calls.every((call) => call.authorization === "Bearer secret"), true);
  assert.deepEqual(calls[2]?.body, { group_id: "456", no_cache: true });
});

test("NapCat gateway rejects a different or offline personal account", async () => {
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (input) => {
    const action = String(input).split("/").at(-1);
    const data = action === "get_login_info"
      ? { user_id: 99, nickname: "Wrong Account" }
      : action === "get_status"
        ? { online: false, good: false }
        : { group_id: 456, group_name: "Mix Feedback" };
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data }), { status: 200 });
  });

  await assert.rejects(
    gateway.verifyPersonalAccount({ accountId: "42", groupId: "456" }),
    /logged in as QQ 99; expected 42/,
  );
});

test("NapCat gateway classifies a definitive group rejection as a scope mismatch", async () => {
  const gateway = new OneBotHttpGateway("http://127.0.0.1:3000", async (input) => {
    const action = String(input).split("/").at(-1);
    if (action === "get_group_info") {
      return new Response(JSON.stringify({ status: "failed", retcode: 100, message: "group not found" }), {
        status: 200,
      });
    }
    const data = action === "get_login_info"
      ? { user_id: 42, nickname: "Mix Account" }
      : { online: true, good: true };
    return new Response(JSON.stringify({ status: "ok", retcode: 0, data }), { status: 200 });
  });

  await assert.rejects(
    gateway.verifyPersonalAccount({ accountId: "42", groupId: "456" }),
    (error) => error instanceof OneBotVerificationError && error.reason === "scope",
  );
});
