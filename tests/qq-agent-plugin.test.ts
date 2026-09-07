import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Context } from "@deepseek-ai/cordis";
import { LlmError } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { zipSync } from "fflate";

import { LocalArtifactStore } from "../src/communication/artifact-store.js";
import { JsonlMaterialCatalog } from "../src/communication/material-catalog.js";
import type { InboundTurn, OutboundMessage } from "../src/contracts/communication.js";
import { RetryableInboundError } from "../src/contracts/communication.js";
import type {
  MixingPreviewRequest,
  MixingRecoveryRequest,
  MixingRuntimeRequest,
} from "../src/mixing/runtime.js";
import {
  type CompletedMix,
  assertQqAgentTurnSucceeded,
  buildQqAgentPrompt,
  configureQqAgentPermissions,
  configureQqAgentToolScope,
  createQqGroupDeliveryTool,
  createQqAgentTurnDrain,
  createQqMixTool,
  createQqMixFailureTracker,
  createQqRenderTool,
  createReaperDocsEvidenceGate,
  createQqUnpackTool,
  deterministicSessionId,
  deliverQqAgentFailure,
  installQqAgentModel,
  handleQqAgentTurnFailure,
  QqAgentLifecycleDisposedError,
  knownQqAgentConversations,
  prewarmKnownQqAgentConversations,
  qqAgentDeliveryId,
  qqAgentAccess,
  qqAgentInheritedTools,
  qqAgentReplyTarget,
  qqMixSessionId,
  qqAgentPreset,
  qqAgentSessionNamespace,
  projectQqAgentDeliveryReceipt,
  recoverQqCompletedMix,
  recordQqAgentDeliveryReceipt,
} from "../src/plugins/qq-agent-plugin.js";

const turn: InboundTurn = {
  schema: "rma.inbound-turn/v2",
  idempotencyKey: "qq:42:private:7:100",
  channel: { kind: "qq", accountId: "42", conversation: { kind: "private", id: "7" } },
  messageId: "100",
  sender: { id: "7", displayName: "Singer" },
  occurredAt: "2026-08-20T00:00:00.000Z",
  text: "用我刚发的人声做一版，结果发群里",
  attachments: [],
};

const artifact = {
  schema: "rma.artifact-ref/v1" as const,
  artifactId: `artifact:${"c".repeat(64)}`,
  kind: "audio" as const,
  availability: "available" as const,
  fileName: "lead.wav",
  bytes: 100,
  sha256: "c".repeat(64),
};

test("QQ agent starts a fresh namespace after its durable prompt/tool contract changes", () => {
  assert.equal(qqAgentSessionNamespace, "qq-chat-v8");
});

test("QQ agent eagerly reserves every configured conversation before accepting turns", async () => {
  const config = {
    configPath: "/tmp/local.toml",
    accountId: "3944407153",
    defaultGroupId: "733720603",
    groupIds: ["733720603", "99887766"],
    trustedPrivateUserIds: ["350217866"],
  };
  assert.deepEqual(knownQqAgentConversations(config), [
    { identity: "3944407153:private:350217866", access: "trusted-private" },
    { identity: "3944407153:group:733720603", access: "restricted" },
    { identity: "3944407153:group:99887766", access: "restricted" },
  ]);

  const acquired: string[] = [];
  await prewarmKnownQqAgentConversations(config, async ({ identity }) => {
    acquired.push(identity);
  });
  assert.deepEqual(acquired, [
    "3944407153:private:350217866",
    "3944407153:group:733720603",
    "3944407153:group:99887766",
  ]);
});

test("QQ agent reload waits for an active turn before disposing its handles", async () => {
  const turns = createQqAgentTurnDrain();
  let releaseTurn!: () => void;
  const activeTurn = turns.run(() => new Promise<void>((resolve) => { releaseTurn = resolve; }));
  let drained = false;
  const drain = turns.drain().then(() => { drained = true; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  await assert.rejects(turns.run(async () => undefined), /RMA_QQ_AGENT_RELOADING/u);

  releaseTurn();
  await Promise.all([activeTurn, drain]);
  assert.equal(drained, true);
});

test("trusted QQ shell cannot launch a REAPER Lua script before current docs evidence exists", () => {
  const gate = createReaperDocsEvidenceGate();
  const launch = {
    name: "bash",
    arguments: { command: '"/Applications/REAPER.app/Contents/MacOS/REAPER" /tmp/change-fx.lua' },
  } as never;
  const success = { isError: false } as never;

  assert.match(gate.guard(launch) ?? "", /reaper_docs.*status.*search.*describe_api/u);
  gate.observe({ name: "mcp__reaper_docs__status" } as never, success);
  assert.match(gate.guard(launch) ?? "", /search.*describe_api/u);
  gate.observe({ name: "mcp__reaper_docs__describe_api" } as never, success);
  assert.equal(gate.guard(launch), undefined);
  gate.reset();
  assert.match(gate.guard(launch) ?? "", /reaper_docs/u);
  gate.observe({ name: "mcp__reaper_docs__search" } as never, success);
  gate.observe({ name: "mcp__reaper_docs__status" } as never, success);
  assert.match(gate.guard(launch) ?? "", /search.*describe_api/u);
  gate.observe({ name: "mcp__reaper_docs__search" } as never, success);
  assert.equal(gate.guard(launch), undefined);
});

test("QQ agent prompt separates ordinary chat from explicit mixing and exposes only durable material identities", () => {
  const prompt = buildQqAgentPrompt(turn, [artifact]);

  assert.match(prompt, /你叫“混音牛马”/u);
  assert.match(prompt, /活多话少/u);
  assert.match(prompt, /不贬低用户/u);
  assert.match(prompt, /不能假装已经试听、混音或渲染/u);
  assert.match(prompt, /工具返回错误.*不等于宿主要求停止.*自行决定.*查文档.*继续执行或停止/u);
  assert.match(prompt, /普通聊天.*绝对不要调用 mix_audio/u);
  assert.match(prompt, /混音基础.*先调用 mixing_knowledge.*不是固定参数表/u);
  assert.match(prompt, /只有用户明确要求.*才调用 mix_audio/u);
  assert.match(prompt, /已经.*修改.*render_demo.*不要再调用 mix_audio/u);
  assert.match(prompt, /试听交付默认 MP3.*明确要求 WAV/u);
  assert.match(prompt, /每个素材填写独立.*trackName.*不得.*合到同一轨/u);
  assert.match(prompt, /list_materials.*随时重新读取/u);
  assert.match(prompt, /明确要求重建工程.*rebuild_project/u);
  assert.match(prompt, /私聊.*明确要求.*发群里.*send_to_group/u);
  assert.match(prompt, /通信层自动用 QQ 原生引用回复.*不要自行调用 NapCat/u);
  assert.match(prompt, new RegExp(`当前入站消息 ID：${turn.messageId}`, "u"));
  assert.match(prompt, /不得尝试原始 Computer Use/u);
  assert.match(prompt, new RegExp(artifact.artifactId, "u"));
  assert.match(prompt, /lead\.wav/u);
  assert.equal(prompt.includes("/tmp/"), false);
  assert.equal(deterministicSessionId("qq-chat", "42:private:7"), deterministicSessionId("qq-chat", "42:private:7"));
  assert.deepEqual(qqAgentInheritedTools, ["mixing_status", "mixing_knowledge"]);
});

test("render_demo exports the accepted REAPER project without invoking the mixing pipeline", async () => {
  let request: MixingPreviewRequest | undefined;
  let completedArtifactId: string | undefined;
  const tool = createQqRenderTool(
    {
      run: async () => { throw new Error("render_demo must not invoke mix_audio"); },
      renderPreview: async (input) => {
        request = input;
        return {
          iteration: 4,
          artifact,
          rendered: {
            projectId: "project-current",
            path: "/audio/demo.wav",
            fileName: "demo.wav",
            sampleRate: 48_000,
            channels: 2,
            format: "wav",
            bytes: 100,
            sha256: "c".repeat(64),
            renderBounds: "entire-project",
            tailSeconds: 2,
          },
        };
      },
      recordDelivery: async () => undefined,
    },
    () => ({ turn, availableMaterials: [] }),
    (_agentId, completed) => { completedArtifactId = completed.result.artifact.artifactId; },
  );

  const result = await tool.execute({ delivery: "default-group" }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext) as { artifactId: string };

  assert.equal(tool.name, "render_demo");
  assert.equal(request?.sourceEventId, turn.idempotencyKey);
  assert.equal(request?.expectedDeliveryId, qqAgentDeliveryId(turn));
  assert.equal(request?.deliveryFormat, "mp3");
  assert.equal(request?.deliveryTarget, "default-group");
  assert.equal(result.artifactId, artifact.artifactId);
  assert.equal(completedArtifactId, artifact.artifactId);
});

test("private QQ turns can explicitly route their final reply to the configured group", async () => {
  let selected: string | undefined;
  const tool = createQqGroupDeliveryTool(
    {} as never,
    () => ({ turn, availableMaterials: [] }),
    (_agentId, delivery) => { selected = delivery; },
    () => undefined,
  );

  const result = await tool.execute({}, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext) as { delivery: string };

  assert.equal(selected, "default-group");
  assert.deepEqual(result, { delivery: "default-group" });
  assert.deepEqual(qqAgentReplyTarget(turn, "314", "default-group"), {
    kind: "qq",
    accountId: "42",
    conversation: { kind: "group", id: "314" },
  });
  assert.equal(qqAgentReplyTarget(turn, "314", "source"), turn.channel);
});


test("send_to_group with version redelivers an existing render without rendering", async () => {
  let completed: { readonly result: { readonly iteration: number } } | undefined;
  let selected: string | undefined;
  const runtime = {
    findRenderedVersion: async (_sessionId: string, version: number) => version === 17
      ? {
          iteration: 17,
          artifact: { artifactId: "artifact:abc", kind: "audio", fileName: "demo-v017.mp3", mediaType: "audio/mpeg" },
          rendered: { projectId: "p", path: "/x/demo.wav", fileName: "demo-v017.wav", sampleRate: 48_000, channels: 2, format: "wav", bytes: 1, sha256: "a".repeat(64), renderBounds: "entire-project", tailSeconds: 2 },
        }
      : undefined,
  };
  const tool = createQqGroupDeliveryTool(
    runtime as never,
    () => ({ turn, availableMaterials: [] }),
    (_agentId, delivery) => { selected = delivery; },
    (_agentId, mix) => { completed = mix; },
  );
  const result = await tool.execute({ version: 17 }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext) as { delivery: string; version: number };
  assert.deepEqual(result, { delivery: "default-group", version: 17 });
  assert.equal(completed?.result.iteration, 17);
  // A failed lookup must NOT flag the turn for group delivery (reply leak guard).
  selected = undefined;
  await assert.rejects(tool.execute({ version: 99 }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /v099/u);
  assert.equal(selected, undefined);
});

test("private QQ turns can redeliver their latest render to the default group", async () => {
  let requestedSessionId: string | undefined;
  let completed: { readonly result: { readonly iteration: number } } | undefined;
  let selected: string | undefined;
  const runtime = {
    findLatestRendered: async (sessionId: string) => {
      requestedSessionId = sessionId;
      return {
        iteration: 89,
        artifact: { artifactId: "artifact:latest", kind: "audio", fileName: "everytime-v089.mp3", mediaType: "audio/mpeg" },
        rendered: { projectId: "p", path: "/x/demo.wav", fileName: "everytime-v089.wav", sampleRate: 48_000, channels: 2, format: "wav", bytes: 1, sha256: "a".repeat(64), renderBounds: "entire-project", tailSeconds: 2 },
      };
    },
  };
  const tool = createQqGroupDeliveryTool(
    runtime as never,
    () => ({ turn, availableMaterials: [] }),
    (_agentId, delivery) => { selected = delivery; },
    (_agentId, mix) => { completed = mix; },
  );

  const result = await tool.execute({ latest: true }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext) as { delivery: string; latest: boolean };

  assert.equal(requestedSessionId, qqMixSessionId(turn));
  assert.equal(selected, "default-group");
  assert.equal(completed?.result.iteration, 89);
  assert.deepEqual(result, { delivery: "default-group", latest: true });
});

test("group QQ turns cannot infer a project from the speaking member", async () => {
  const groupTurn: InboundTurn = {
    ...turn,
    sender: { id: "another-member", displayName: "Listener" },
    channel: { ...turn.channel, conversation: { kind: "group", id: "314" } },
  };
  const tool = createQqGroupDeliveryTool(
    {} as never,
    () => ({ turn: groupTurn, availableMaterials: [] }),
    () => undefined,
    () => undefined,
  );
  await assert.rejects(tool.execute({ latest: true }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /必须指定.*工程名/u);
});

test("group QQ turns resolve a named project's latest render independently of the speaker", async () => {
  const groupTurn: InboundTurn = {
    ...turn,
    sender: { id: "another-member", displayName: "Listener" },
    channel: { ...turn.channel, conversation: { kind: "group", id: "314" } },
  };
  let query: { readonly project: string; readonly version?: number } | undefined;
  let completed: CompletedMix | undefined;
  const tool = createQqGroupDeliveryTool(
    {
      findProjectRendered: async (project: string, version?: number) => {
        query = { project, ...(version === undefined ? {} : { version }) };
        return {
          projectName: "everytime",
          sessionId: "qq-mix-project-owner",
          iteration: 89,
          artifact: { artifactId: "artifact:latest", kind: "audio", fileName: "everytime-v089.mp3", mediaType: "audio/mpeg" },
          rendered: { projectId: "p", path: "/x/demo.wav", fileName: "everytime-v089.wav", sampleRate: 48_000, channels: 2, format: "wav", bytes: 1, sha256: "a".repeat(64), renderBounds: "entire-project", tailSeconds: 2 },
        };
      },
    } as never,
    () => ({ turn: groupTurn, availableMaterials: [] }),
    () => undefined,
    (_agentId, mix) => { completed = mix; },
  );

  const result = await tool.execute({ project: "everytime", latest: true }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext);

  assert.deepEqual(query, { project: "everytime" });
  assert.equal(completed?.sessionId, "qq-mix-project-owner");
  assert.deepEqual(result, { delivery: "source", project: "everytime", latest: true });
});

test("group QQ turns cannot redirect their reply with the private delivery tool", async () => {
  const groupTurn: InboundTurn = {
    ...turn,
    channel: { ...turn.channel, conversation: { kind: "group", id: "314" } },
  };
  assert.equal(qqAgentReplyTarget(groupTurn, "999", "default-group"), groupTurn.channel);
  const tool = createQqGroupDeliveryTool(
    {} as never,
    () => ({ turn: groupTurn, availableMaterials: [] }),
    () => undefined,
    () => undefined,
  );

  await assert.rejects(tool.execute({}, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /private QQ turns/u);

  const mixTool = createQqMixTool(
    {
      run: async () => { throw new Error("group redirect must be rejected before mixing"); },
      recordDelivery: async () => undefined,
    },
    () => ({ turn: groupTurn, availableMaterials: [] }),
    () => undefined,
  );
  await assert.rejects(mixTool.execute({
    feedback: "混一版并改投默认群",
    materials: [],
    delivery: "default-group",
  }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /private QQ turns/u);
});

test("allowlisted private QQ conversations deny UI-only blocking tools", async () => {
  let mountedPreset: string | undefined;
  const restrictedCalls: unknown[] = [];
  const hostContext = {
    agentPresets: {
      mount: async (_agentContext: Context, preset: string) => {
        mountedPreset = preset;
        return { id: preset };
      },
    },
  } as unknown as Context;
  const agentContext = {
    tools: {
      restrict: (options: unknown) => { restrictedCalls.push(options); },
    },
  } as unknown as Context;

  const access = qqAgentAccess(turn, [turn.sender.id]);
  await configureQqAgentToolScope(hostContext, agentContext, access);
  const prompt = buildQqAgentPrompt(turn, [artifact], access);

  assert.equal(access, "trusted-private");
  assert.equal(mountedPreset, "standard");
  assert.equal(qqAgentPreset, "standard");
  assert.deepEqual(restrictedCalls, [{ deny: ["ask_user_question"] }]);
  assert.match(prompt, /继承当前 DSH 已安装的完整工具与 Skill/u);
  assert.match(prompt, /不是能力上限/u);
  assert.match(prompt, /不要因为快捷工具的输入范围拒绝整个任务/u);
  assert.match(prompt, /先用 reaper_docs MCP 查询本机当前版本的 ReaScript 文档/u);
  assert.match(prompt, /status.*refresh.*search.*describe_api/u);
  assert.match(prompt, /允许自行编写并执行临时 ReaScript\/Lua/u);
  assert.match(prompt, /任何 FabFilter FX 链增删或替换前.*mcp__fabfilter__list_installed/u);
  assert.match(prompt, /设置具体 FabFilter 自动化参数前.*必须依次调用.*describe.*probe/u);
  assert.match(prompt, /幂等.*预期的当前 FX 链/u);
  assert.match(prompt, /执行前后.*mixing_status.*单个 Undo block.*失败时.*Undo_DoUndo2/u);
  assert.match(prompt, /不受 Mixing Runtime mutation queue 保护.*不要主动与 mix_audio 并发/u);
  assert.match(prompt, /QQ 入站可能在重启后重放.*目标状态已经达到.*no-op/u);
  assert.match(prompt, /不得调用 ask_user_question/u);
  assert.match(prompt, /信息足够时自行采用合理默认并执行/u);
  assert.match(prompt, /关键歧义.*普通文本/u);
  assert.doesNotMatch(prompt, /不得尝试原始 Computer Use/u);
});

test("QQ conversations apply the permission preset for their current trust level", () => {
  const trustedSession = { events: [] };
  const restrictedSession = { events: [] };
  const selections: Array<{ session: unknown; preset: string }> = [];
  const hostContext = {
    permissionPresets: {
      set: (selectedSession: unknown, preset: string) => {
        selections.push({ session: selectedSession, preset });
      },
    },
  } as unknown as Context;
  const trustedAgentContext = { agent: { session: trustedSession } } as unknown as Context;
  const restrictedAgentContext = { agent: { session: restrictedSession } } as unknown as Context;

  configureQqAgentPermissions(hostContext, trustedAgentContext, "trusted-private");
  configureQqAgentPermissions(hostContext, restrictedAgentContext, "restricted");

  assert.deepEqual(selections, [
    { session: trustedSession, preset: "danger-full-access" },
    { session: restrictedSession, preset: "workspace-write" },
  ]);
});

test("group QQ conversations keep the restricted high-level tool scope", async () => {
  const groupTurn: InboundTurn = {
    ...turn,
    channel: { ...turn.channel, conversation: { kind: "group", id: "314" } },
  };
  const restrictedCalls: unknown[] = [];
  const agentContext = {
    tools: {
      restrict: (options: unknown) => { restrictedCalls.push(options); },
    },
  } as unknown as Context;
  const hostContext = {
    agentPresets: { mount: async () => ({ id: qqAgentPreset }) },
  } as unknown as Context;

  const access = qqAgentAccess(groupTurn, [turn.sender.id]);
  await configureQqAgentToolScope(hostContext, agentContext, access);

  assert.equal(access, "restricted");
  assert.deepEqual(restrictedCalls, [{ allow: ["mixing_status", "mixing_knowledge"] }]);
  const prompt = buildQqAgentPrompt(groupTurn, [], access);
  assert.match(prompt, /不得尝试原始 Computer Use/u);
  assert.doesNotMatch(prompt, /允许自行编写并执行临时 ReaScript\/Lua/u);
});

test("QQ agent binds its configured DSH model to prompt assembly and request routing", async () => {
  const handlers = new Map<string, unknown>();
  const agentContext = {
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
      return () => undefined;
    },
  } as unknown as Context;
  installQqAgentModel(agentContext, { provider: "kimi-coding", model: "kimi-k3" });

  const assemble = handlers.get("system-prompt/assemble") as (
    assembly: unknown,
    context: unknown,
    next: () => Promise<{ variables: Readonly<Record<string, string>> }>,
  ) => Promise<{ variables: Readonly<Record<string, string>> }>;
  const request = handlers.get("agent/request") as (
    payload: unknown,
    next: () => Promise<{ provider: string; model: string }>,
  ) => Promise<{ provider: string; model: string }>;
  const assembled = await assemble({}, {}, async () => ({ variables: { cwd: "/workspace" } }));
  const routed = await request({}, async () => ({ provider: "wrong", model: "wrong" }));

  assert.deepEqual(assembled.variables, {
    cwd: "/workspace",
    provider: "kimi-coding",
    model: "kimi-k3",
  });
  assert.deepEqual(routed, { provider: "kimi-coding", model: "kimi-k3" });
});

test("QQ agent surfaces a failed DSH turn instead of sending a successful fallback", () => {
  assert.throws(() => assertQqAgentTurnSucceeded([
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: "step/end", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 3,
      time: 4,
      data: {
        turn: 1,
        reason: { kind: "error", error: { code: "NO_ADAPTER", message: "model route missing" } },
      },
    },
  ]), /QQ agent turn failed: model route missing/u);

  assert.doesNotThrow(() => assertQqAgentTurnSucceeded([
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: "step/end", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 3, time: 4, data: { turn: 1, reason: { kind: "completed" } } },
  ]));
});

test("QQ agent preserves DSH rate-limit metadata as retryable backpressure", () => {
  assert.throws(() => assertQqAgentTurnSucceeded([
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: "step/end", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 3,
      time: 4,
      data: {
        turn: 1,
        reason: {
          kind: "error",
          error: {
            code: "RATE_LIMIT",
            message: "Too many requests",
            status: 429,
            providerRetryAfterMs: 12_000,
          },
        },
      },
    },
  ]), (error: unknown) => error instanceof RetryableInboundError
    && error.retryAfterMs === 12_000
    && /Too many requests/u.test(error.message));
});

test("QQ agent maps DSH's structured disposed outcome to a replayable lifecycle error", () => {
  assert.throws(() => assertQqAgentTurnSucceeded([
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: "step/end", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 3,
      time: 4,
      data: {
        turn: 1,
        reason: { kind: "aborted", reason: { kind: "disposed" } },
      },
    },
  ]), (error: unknown) => error instanceof QqAgentLifecycleDisposedError
    && error.code === "RMA_QQ_AGENT_LIFECYCLE_DISPOSED");
});

test("QQ agent converts exhausted 403 quota into manually resumable backpressure", () => {
  assert.throws(() => assertQqAgentTurnSucceeded([
    { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: 2, data: { turn: 1, step: 1 } },
    { type: "step/end", seq: 2, time: 3, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: 3,
      time: 4,
      data: {
        turn: 1,
        reason: {
          kind: "error",
          error: { code: "QUOTA", message: "Insufficient balance", status: 403 },
        },
      },
    },
  ]), (error: unknown) => error instanceof RetryableInboundError
    && error.resumePolicy === "manual"
    && /Insufficient balance/u.test(error.message));
});

test("QQ agent reports a manually paused quota turn without settling it", async () => {
  let outbound: OutboundMessage | undefined;
  const quota = new RetryableInboundError("Insufficient balance", { resumePolicy: "manual" });
  await assert.rejects(deliverQqAgentFailure({
    deliver: async (message) => {
      outbound = message;
      return {
        schema: "rma.delivery-receipt/v1",
        deliveryId: message.deliveryId,
        status: "delivered",
        platformMessageId: "quota-paused-1",
        occurredAt: "2026-08-24T00:00:00.000Z",
      };
    },
  }, turn, quota, new AbortController().signal), (error: unknown) => error === quota);

  assert.equal(outbound?.deliveryId, `qq-agent-paused:${turn.idempotencyKey}`);
  assert.equal(outbound?.settlesInboundIdempotencyKey, undefined);
  assert.match(outbound?.text ?? "", /额度.*排队.*继续/u);
});

test("QQ agent does not settle a rate-limited turn with a failure notice", async () => {
  let deliveries = 0;
  const rateLimit = new RetryableInboundError("Too many requests", { retryAfterMs: 1_000 });
  await assert.rejects(deliverQqAgentFailure({
    deliver: async () => {
      deliveries += 1;
      throw new Error("rate-limited turns must remain pending");
    },
  }, turn, rateLimit, new AbortController().signal), (error: unknown) => error === rateLimit);

  assert.equal(deliveries, 0);
});

test("a disposed QQ agent turn stays pending instead of being silently settled", async () => {
  let deliveries = 0;
  const disposed = new QqAgentLifecycleDisposedError();

  await assert.rejects(handleQqAgentTurnFailure({
    deliver: async () => {
      deliveries += 1;
      throw new Error("a disposed turn must not attempt a settling delivery");
    },
  }, turn, disposed, new AbortController().signal), (error: unknown) => error === disposed);

  assert.equal(deliveries, 0);
});

test("an ordinary failure mentioning aborted is reported instead of replayed forever", async () => {
  let outbound: OutboundMessage | undefined;
  await handleQqAgentTurnFailure({
    deliver: async (message) => {
      outbound = message;
      return {
        schema: "rma.delivery-receipt/v1",
        deliveryId: message.deliveryId,
        status: "delivered",
        platformMessageId: "failure-aborted-text",
        occurredAt: "2026-08-24T00:00:00.000Z",
      };
    },
  }, turn, new Error("render aborted after bridge timeout"), new AbortController().signal);

  assert.equal(outbound?.settlesInboundIdempotencyKey, turn.idempotencyKey);
});

test("QQ agent sends an explicit source-channel error when its turn fails", async () => {
  let outbound: OutboundMessage | undefined;
  await deliverQqAgentFailure({
    deliver: async (message) => {
      outbound = message;
      return {
        schema: "rma.delivery-receipt/v1",
        deliveryId: message.deliveryId,
        status: "delivered",
        platformMessageId: "failure-message-1",
        occurredAt: "2026-08-20T00:04:00.000Z",
      };
    },
  }, turn, new Error("mix_audio failed before rendering"), new AbortController().signal);

  assert.equal(outbound?.deliveryId, `qq-agent-failure:${turn.idempotencyKey}`);
  assert.equal(outbound?.target, turn.channel);
  assert.equal(outbound?.settlesInboundIdempotencyKey, turn.idempotencyKey);
  assert.equal(outbound?.replyToMessageId, turn.messageId);
  assert.deepEqual(outbound?.artifacts, []);
  assert.match(outbound?.text ?? "", /处理失败/u);
  assert.match(outbound?.text ?? "", /mix_audio failed before rendering/u);
  assert.doesNotMatch(outbound?.text ?? "", /已完成/u);
});

test("QQ agent preserves a readable message from a structured tool failure", async () => {
  let text = "";
  await deliverQqAgentFailure({
    deliver: async (message) => {
      text = message.text;
      return {
        schema: "rma.delivery-receipt/v1",
        deliveryId: message.deliveryId,
        status: "delivered",
        occurredAt: "2026-08-20T00:05:00.000Z",
      };
    },
  }, turn, { message: "renderer lost its REAPER heartbeat" }, new AbortController().signal);

  assert.match(text, /renderer lost its REAPER heartbeat/u);
  assert.doesNotMatch(text, /不可读错误/u);
});

test("a definitive rejected QQ delivery settles the inbound turn without replaying the model", async () => {
  const deliveries: unknown[] = [];
  const runtime = {
    run: async () => { throw new Error("mixing must not rerun"); },
    recordDelivery: async (request: unknown) => { deliveries.push(request); },
  };
  const completedMix = {
    delivery: "default-group" as const,
    sessionId: "registered-project-session",
    result: {
      iteration: 3,
      plan: {
        schema: "rma.mix-plan/v2" as const,
        sourceEventId: turn.idempotencyKey,
        sourceText: turn.text,
        summary: "已完成但文件被 QQ 拒绝",
        actions: [{
          type: "track.gain.delta" as const,
          track: { guid: "{TRACK-1}", name: "LEAD VOCAL" } as const,
          deltaDb: 1,
          reason: "测试",
        }],
      },
      adjustments: [],
      artifact,
      rendered: {
        projectId: "project-1",
        path: "/audio/demo.wav",
        fileName: "demo.wav",
        sampleRate: 48_000 as const,
        channels: 2 as const,
        format: "wav" as const,
        bytes: 100,
        sha256: "c".repeat(64),
        renderBounds: "entire-project" as const,
        tailSeconds: 2,
      },
    },
  };

  await assert.doesNotReject(recordQqAgentDeliveryReceipt({
    runtime,
    turn,
    completedMix,
    deliveryId: `qq-agent:${turn.idempotencyKey}`,
  }, {
    schema: "rma.delivery-receipt/v1",
    deliveryId: `qq-agent:${turn.idempotencyKey}`,
    status: "rejected",
    occurredAt: "2026-08-20T00:01:00.000Z",
    errorCode: "RMA_DELIVERY_REJECTED",
  }));
  assert.equal(deliveries.length, 1);
  assert.equal((deliveries[0] as { readonly sessionId?: string }).sessionId, "registered-project-session");
});

test("a settled QQ delivery remains terminal when its mixing-ledger projection fails", async () => {
  let reconciliationStatus: string | undefined;
  await assert.doesNotReject(projectQqAgentDeliveryReceipt({
    runtime: {
      run: async () => { throw new Error("mixing must not rerun"); },
      recordDelivery: async () => { throw new Error("ledger unavailable"); },
    },
    turn,
    completedMix: {
      delivery: "source",
      result: {
        iteration: 3,
        plan: {
          schema: "rma.mix-plan/v2",
          sourceEventId: turn.idempotencyKey,
          sourceText: turn.text,
          summary: "已完成",
          actions: [{
            type: "track.gain.delta",
            track: { guid: "{TRACK-1}", name: "LEAD VOCAL" },
            deltaDb: 1,
            reason: "测试",
          }],
        },
        adjustments: [],
        artifact,
        rendered: {
          projectId: "project-1",
          path: "/audio/demo.wav",
          fileName: "demo.wav",
          sampleRate: 48_000,
          channels: 2,
          format: "wav",
          bytes: 100,
          sha256: "c".repeat(64),
          renderBounds: "entire-project",
          tailSeconds: 2,
        },
      },
    },
    deliveryId: qqAgentDeliveryId(turn),
  }, {
    schema: "rma.delivery-receipt/v1",
    deliveryId: qqAgentDeliveryId(turn),
    status: "rejected",
    occurredAt: "2026-08-20T00:02:00.000Z",
    errorCode: "RMA_DELIVERY_REJECTED",
  }, (receipt) => { reconciliationStatus = receipt.status; }));

  assert.equal(reconciliationStatus, "rejected");
});

test("an uncertain QQ delivery preserves inbox replay when its mixing projection fails", async () => {
  let reconciliationStatus: string | undefined;
  await assert.rejects(projectQqAgentDeliveryReceipt({
    runtime: {
      run: async () => { throw new Error("mixing must not rerun"); },
      recordDelivery: async () => { throw new Error("ledger unavailable"); },
    },
    turn,
    completedMix: {
      delivery: "source",
      result: {
        iteration: 3,
        plan: {
          schema: "rma.mix-plan/v2",
          sourceEventId: turn.idempotencyKey,
          sourceText: turn.text,
          summary: "已完成",
          actions: [{
            type: "track.gain.delta",
            track: { guid: "{TRACK-1}", name: "LEAD VOCAL" },
            deltaDb: 1,
            reason: "测试",
          }],
        },
        adjustments: [],
        artifact,
        rendered: {
          projectId: "project-1",
          path: "/audio/demo.wav",
          fileName: "demo.wav",
          sampleRate: 48_000,
          channels: 2,
          format: "wav",
          bytes: 100,
          sha256: "c".repeat(64),
          renderBounds: "entire-project",
          tailSeconds: 2,
        },
      },
    },
    deliveryId: qqAgentDeliveryId(turn),
  }, {
    schema: "rma.delivery-receipt/v1",
    deliveryId: qqAgentDeliveryId(turn),
    status: "uncertain",
    occurredAt: "2026-08-20T00:03:00.000Z",
    errorCode: "RMA_DELIVERY_UNCERTAIN",
  }, (receipt) => { reconciliationStatus = receipt.status; }), /ledger unavailable/u);

  assert.equal(reconciliationStatus, "uncertain");
});

test("QQ resumes a durable rendered mix before any new model or REAPER run", async () => {
  let runCalls = 0;
  let recoveryRequest: unknown;
  const result = {
    iteration: 4,
    plan: {
      schema: "rma.mix-plan/v2" as const,
      sourceEventId: turn.idempotencyKey,
      sourceText: turn.text,
      summary: "恢复已有 MP3 发布",
      actions: [{
        type: "track.gain.delta" as const,
        track: { guid: "{TRACK-1}", name: "LEAD VOCAL" } as const,
        deltaDb: 1,
        reason: "测试",
      }],
    },
    adjustments: [],
    artifact,
    rendered: {
      projectId: "project-1",
      path: "/audio/demo.wav",
      fileName: "demo.wav",
      sampleRate: 48_000 as const,
      channels: 2 as const,
      format: "wav" as const,
      bytes: 100,
      sha256: "c".repeat(64),
      renderBounds: "entire-project" as const,
      tailSeconds: 2,
    },
  };
  const signal = new AbortController().signal;
  const recovered = await recoverQqCompletedMix({
    run: async () => {
      runCalls += 1;
      throw new Error("model/REAPER path must not run during recovery");
    },
    recordDelivery: async () => undefined,
    resumePending: async (request) => {
      recoveryRequest = request;
      return { result, deliveryFormat: "mp3", deliveryTarget: "default-group" };
    },
  }, turn, signal);

  assert.equal(runCalls, 0);
  const request = recoveryRequest as MixingRecoveryRequest;
  assert.equal(request.sessionId, qqMixSessionId(turn));
  assert.equal(request.sourceEventId, turn.idempotencyKey);
  assert.equal(request.expectedDeliveryId, qqAgentDeliveryId(turn));
  assert.equal(request.signal, signal);
  assert.equal(recovered?.delivery, "default-group");
  assert.equal(recovered?.result.iteration, 4);
});

test("unpack_archive expands only the current QQ user's ZIP and publishes child materials to the same turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-qq-unpack-"));
  const source = join(root, "session.zip");
  await writeFile(source, zipSync({
    "session/伴奏.wav": Buffer.from("RIFF\0\0\0\0WAVEbeat"),
    "session/主唱.wav": Buffer.from("RIFF\0\0\0\0WAVElead"),
  }));
  const store = new LocalArtifactStore(join(root, "artifacts"), 1024 * 1024);
  const catalog = new JsonlMaterialCatalog(join(root, "materials.jsonl"));
  const archive = await store.importFile({ kind: "file", filePath: source, fileName: "session.zip" }, new AbortController().signal);
  let active = { turn, availableMaterials: [archive] as readonly typeof archive[] };
  const tool = createQqUnpackTool(
    store,
    catalog,
    () => active,
    (_agentId, materials) => {
      active = { turn, availableMaterials: [...active.availableMaterials, ...materials] };
    },
  );

  const result = await tool.execute({ archiveArtifactId: archive.sha256 }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext) as {
    materials: Array<{ artifactId: string; fileName: string; kind: string }>;
  };

  assert.deepEqual(result.materials.map((entry) => entry.fileName).sort(), ["主唱.wav", "伴奏.wav"]);
  assert.ok(result.materials.every((entry) => entry.kind === "audio"));
  assert.equal(active.availableMaterials.length, 3);
  assert.equal((await catalog.list("42", "7")).length, 2);

  await assert.rejects(tool.execute({ archiveArtifactId: "d".repeat(64) }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /not available to this QQ user/u);
});

test("mix_audio canonicalizes a model-supplied bare digest to the QQ user's durable material", async () => {
  let request: MixingRuntimeRequest | undefined;
  let completedDelivery: string | undefined;
  const tool = createQqMixTool(
    {
      run: async (input) => {
        request = input;
        return {
          iteration: 1,
          plan: {
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
          },
          adjustments: [],
          artifact,
          rendered: {
            projectId: "project-1",
            path: "/audio/demo.wav",
            fileName: "demo.wav",
            sampleRate: 48_000,
            channels: 2,
            format: "wav",
            bytes: 100,
            sha256: "c".repeat(64),
            renderBounds: "entire-project",
            tailSeconds: 2,
          },
        };
      },
      recordDelivery: async () => undefined,
    },
    () => ({ turn, availableMaterials: [artifact] }),
    (_agentId, mix) => { completedDelivery = mix.delivery; },
  );

  const result = await tool.execute({
    feedback: "主唱靠前一点",
    materials: [{ artifactId: artifact.sha256, trackName: "静-主音" }],
    delivery: "default-group",
  }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext) as { artifactId: string };

  assert.equal(request?.sessionId, deterministicSessionId("qq-mix", "42:7"));
  assert.equal(request?.expectedDeliveryId, `qq-agent:${turn.idempotencyKey}`);
  assert.equal(request?.inputArtifacts?.[0]?.trackName, "静-主音");
  assert.equal(request?.inputArtifacts?.[0]?.artifact.artifactId, artifact.artifactId);
  assert.equal(request?.deliveryFormat, "mp3");
  assert.equal(completedDelivery, "default-group");
  assert.equal(result.artifactId, artifact.artifactId);

  await assert.rejects(tool.execute({
    feedback: "不要把两条素材叠成一轨",
    materials: [
      { artifactId: artifact.artifactId, trackName: "静-主音" },
      { artifactId: artifact.artifactId, trackName: "月-主音" },
    ],
    delivery: "source",
  }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /assigned more than once/u);

  await tool.execute({
    feedback: "给我无损 WAV",
    materials: [],
    delivery: "source",
    deliveryFormat: "wav",
  }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext);
  assert.equal(request?.deliveryFormat, "wav");

  await assert.rejects(tool.execute({
    feedback: "使用别人的素材",
    materials: [{ artifactId: "d".repeat(64), trackName: "LEAD VOCAL" }],
    delivery: "source",
  }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /is not available to this QQ user/u);
});

test("mix_audio reports an exhausted planner quota to the durable QQ retry boundary", async () => {
  let retryableFailure: RetryableInboundError | undefined;
  const tracker = createQqMixFailureTracker();
  const tool = createQqMixTool(
    {
      run: async () => {
        throw new LlmError("monthly quota exhausted", "QUOTA", {
          status: 403,
          providerRetryAfterMs: 60_000,
        });
      },
      recordDelivery: async () => undefined,
    },
    () => ({ turn, availableMaterials: [] }),
    () => undefined,
    {
      started: (agentId) => tracker.started(agentId),
      completed: (agentId, attempt) => tracker.completed(agentId, attempt),
      retryableFailure: (agentId, attempt, error) => {
        tracker.retryableFailure(agentId, attempt, error);
        retryableFailure = error;
      },
    },
  );

  await assert.rejects(tool.execute({
    feedback: "主唱更亮",
    materials: [],
    delivery: "source",
  }, {
    signal: new AbortController().signal,
    agent: { id: "qq-agent-1" },
  } as unknown as ToolRunContext), /monthly quota exhausted/u);

  assert.ok(retryableFailure instanceof RetryableInboundError);
  assert.equal(retryableFailure.resumePolicy, "manual");
  assert.equal(retryableFailure.retryAfterMs, 60_000);
  assert.equal(tracker.pending("qq-agent-1"), retryableFailure);
});

test("a later successful mix attempt supersedes an earlier planner failure", () => {
  const tracker = createQqMixFailureTracker();
  const first = tracker.started("qq-agent-1");
  const second = tracker.started("qq-agent-1");
  const error = new RetryableInboundError("quota", { resumePolicy: "manual" });

  tracker.completed("qq-agent-1", second);
  tracker.retryableFailure("qq-agent-1", first, error);

  assert.equal(tracker.pending("qq-agent-1"), undefined);
});
