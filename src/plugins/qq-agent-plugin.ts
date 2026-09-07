import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  foldConsumedWork,
  installModelSelection,
  type AgentHandle,
  type ModelSelectionRef,
} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-presets";
import type {} from "@deepseek-ai/dsh-permission-presets";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage, LlmError, type LlmFailure } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import {
  defineTool,
  type ToolExecution,
  type ToolExecutionResult,
  type ToolGuard,
} from "@deepseek-ai/dsh-tools";
import { z } from "zod";

import { LocalArtifactStore } from "../communication/artifact-store.js";
import { JsonlMaterialCatalog } from "../communication/material-catalog.js";
import type {
  ArtifactRef,
  ChannelRef,
  CommunicationModule,
  DeliveryReceipt,
  InboundTurn,
  PassiveGroupMessage,
} from "../contracts/communication.js";
import {
  isRetryableInboundError,
  RetryableInboundError,
} from "../contracts/communication.js";
import { loadConfig } from "../config.js";
import { createMaterialLibraryTool, createProjectRebuildTool } from "../dsh/project-tools.js";
import type {
  AssignedInputArtifact,
  MixingPreviewResult,
  ProjectFeedbackResult,
  MixingRuntime,
  MixingRuntimeResult,
} from "../mixing/runtime.js";

export const name = "qq-agent";
export const inject = [
  "agents",
  "agentPresets",
  "communication",
  "mixingRuntime",
  "projectManager",
  "permissionPresets",
  "tools",
] as const;
export const qqAgentInheritedTools = ["mixing_status", "mixing_knowledge"] as const;
export const qqAgentUiOnlyTools = ["ask_user_question"] as const;
export const qqAgentPreset = "standard";
export const qqAgentSessionNamespace = "qq-chat-v8";

export const Config = z.strictObject({
  configPath: z.string().min(1),
  accountId: z.string().regex(/^[0-9]+$/u).optional(),
  defaultGroupId: z.string().regex(/^[0-9]+$/u).optional(),
  groupIds: z.array(z.string().regex(/^[0-9]+$/u)).default([]),
  trustedPrivateUserIds: z.array(z.string().regex(/^[0-9]+$/u)).default([]),
});

export type QqAgentPluginConfig = z.infer<typeof Config>;

interface ActiveTurn {
  readonly turn: InboundTurn;
  readonly availableMaterials: readonly ArtifactRef[];
}

export interface CompletedMix {
  readonly result: MixingRuntimeResult | MixingPreviewResult;
  readonly delivery: QqAgentDeliveryTarget;
  readonly summary?: string;
  /** Ledger that owns the artifact; may differ from the QQ sender's personal session. */
  readonly sessionId?: string;
}

export interface QqMixToolObserver {
  started(agentId: string): number;
  completed(agentId: string, attempt: number): void;
  retryableFailure(agentId: string, attempt: number, error: RetryableInboundError): void;
}

export function createQqMixFailureTracker(): {
  started(agentId: string): number;
  completed(agentId: string, attempt: number): void;
  retryableFailure(agentId: string, attempt: number, error: RetryableInboundError): void;
  pending(agentId: string): RetryableInboundError | undefined;
  clear(agentId: string): void;
} {
  const attempts = new Map<string, number>();
  const latestSuccesses = new Map<string, number>();
  const failures = new Map<string, { readonly attempt: number; readonly error: RetryableInboundError }>();
  return {
    started(agentId) {
      const attempt = (attempts.get(agentId) ?? 0) + 1;
      attempts.set(agentId, attempt);
      return attempt;
    },
    completed(agentId, attempt) {
      latestSuccesses.set(agentId, Math.max(latestSuccesses.get(agentId) ?? 0, attempt));
      if ((failures.get(agentId)?.attempt ?? Number.POSITIVE_INFINITY) <= attempt) {
        failures.delete(agentId);
      }
    },
    retryableFailure(agentId, attempt, error) {
      if ((latestSuccesses.get(agentId) ?? 0) >= attempt) return;
      if ((failures.get(agentId)?.attempt ?? 0) > attempt) return;
      failures.set(agentId, { attempt, error });
    },
    pending(agentId) {
      return failures.get(agentId)?.error;
    },
    clear(agentId) {
      attempts.delete(agentId);
      latestSuccesses.delete(agentId);
      failures.delete(agentId);
    },
  };
}

export type QqAgentDeliveryTarget = "source" | "default-group";

export interface QqAgentTurnDrain {
  run<T>(operation: () => Promise<T>): Promise<T>;
  drain(): Promise<void>;
}

export function createQqAgentTurnDrain(): QqAgentTurnDrain {
  let accepting = true;
  let drainTask: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (!accepting) {
        return Promise.reject(new Error(
          "RMA_QQ_AGENT_RELOADING: QQ agent is draining for plugin reload",
        ));
      }
      const pending = Promise.resolve().then(operation);
      active.add(pending);
      void pending.then(
        () => { active.delete(pending); },
        () => { active.delete(pending); },
      );
      return pending;
    },
    drain(): Promise<void> {
      drainTask ??= (async () => {
        accepting = false;
        await Promise.allSettled(active);
      })();
      return drainTask;
    },
  };
}

export interface ReaperDocsEvidenceGate {
  readonly guard: ToolGuard;
  observe(execution: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void;
  reset(): void;
}

function launchesReaperLua(execution: Readonly<ToolExecution>): boolean {
  if (execution.name !== "bash" && execution.name !== "exec_command") return false;
  const serialized = JSON.stringify(execution.arguments);
  return /\.lua(?:["'\s]|$)/iu.test(serialized) && /reaper/iu.test(serialized);
}

export function createReaperDocsEvidenceGate(): ReaperDocsEvidenceGate {
  let phase: "none" | "status" | "lookup" = "none";
  return {
    guard: (execution) => {
      if (!launchesReaperLua(execution)) return undefined;
      if (phase === "none") {
        return "REAPER Lua launch requires successful reaper_docs status, then search or describe_api in this turn";
      }
      if (phase === "status") {
        return "REAPER Lua launch requires successful reaper_docs search or describe_api in this turn";
      }
      return undefined;
    },
    observe: (execution, result) => {
      if (result.isError) return;
      if (execution.name === "mcp__reaper_docs__status") phase = "status";
      if (phase === "status" && (execution.name === "mcp__reaper_docs__search"
        || execution.name === "mcp__reaper_docs__describe_api")) phase = "lookup";
    },
    reset: () => { phase = "none"; },
  };
}

function isPrivateQqTurn(turn: InboundTurn): boolean {
  return turn.channel.kind === "qq"
    && Boolean(turn.channel.accountId)
    && turn.channel.conversation.kind === "private";
}

export function qqAgentReplyTarget(
  turn: InboundTurn,
  defaultGroupId: string | undefined,
  delivery: QqAgentDeliveryTarget,
): ChannelRef {
  if (delivery === "source") return turn.channel;
  if (turn.channel.kind !== "qq" || !turn.channel.accountId) {
    throw new Error("default QQ group delivery is not configured for this turn");
  }
  if (!isPrivateQqTurn(turn)) return turn.channel;
  if (!defaultGroupId) throw new Error("default QQ group delivery is not configured for this turn");
  return {
    kind: "qq",
    accountId: turn.channel.accountId,
    conversation: { kind: "group", id: defaultGroupId },
  };
}

export interface QqAgentDeliveryContext {
  readonly runtime: MixingRuntime;
  readonly turn: InboundTurn;
  readonly completedMix?: CompletedMix;
  readonly deliveryId: string;
}

export function qqMixSessionId(turn: InboundTurn): string {
  return deterministicSessionId(
    "qq-mix",
    `${turn.channel.accountId ?? "unknown"}:${turn.sender.id}`,
  );
}

export function qqAgentDeliveryId(turn: InboundTurn): string {
  return `qq-agent:${turn.idempotencyKey}`;
}

/** Parse `[@123456]` markers out of reply text into OneBot at-mentions. */
export function extractQqMentions(text: string): { readonly text: string; readonly mentions: readonly string[] } {
  const mentions = new Set<string>();
  const cleaned = text
    .replace(/\[@(\d{4,15})\]/g, (_match, qq: string) => { mentions.add(qq); return ""; })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: cleaned, mentions: [...mentions] };
}

function qqAgentFailureDetail(error: unknown): string {
  const structuredMessage = typeof error === "object" && error !== null && "message" in error
    && typeof error.message === "string" ? error.message : undefined;
  const detail = (error instanceof Error ? error.message : structuredMessage ?? String(error)).trim();
  return detail && detail !== "[object Object]" ? detail : "内部工具返回了不可读错误";
}

export async function deliverQqAgentFailure(
  communication: Pick<CommunicationModule, "deliver">,
  turn: InboundTurn,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (isRetryableInboundError(error)) {
    if (error.resumePolicy === "manual") {
      await communication.deliver({
        schema: "rma.outbound-message/v1",
        deliveryId: `qq-agent-paused:${turn.idempotencyKey}`,
        target: turn.channel,
        text: "模型额度已用完，当前任务和后续消息都已排队。额度恢复后请发送“继续”，机器人会从未完成的消息开始处理。",
        artifacts: [],
        replyToMessageId: turn.messageId,
      }, signal);
    }
    throw error;
  }
  await communication.deliver({
    schema: "rma.outbound-message/v1",
    deliveryId: `qq-agent-failure:${turn.idempotencyKey}`,
    target: turn.channel,
    text: `处理失败：${qqAgentFailureDetail(error)}\n本轮已停止，没有生成成功结果。请重试。`,
    artifacts: [],
    settlesInboundIdempotencyKey: turn.idempotencyKey,
    replyToMessageId: turn.messageId,
  }, signal);
}

export async function handleQqAgentTurnFailure(
  communication: Pick<CommunicationModule, "deliver">,
  turn: InboundTurn,
  error: unknown,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || error instanceof QqAgentLifecycleDisposedError) throw error;
  await deliverQqAgentFailure(communication, turn, error, signal);
}

export class QqAgentLifecycleDisposedError extends Error {
  public readonly code = "RMA_QQ_AGENT_LIFECYCLE_DISPOSED";

  public constructor() {
    super("QQ agent lifecycle was disposed while processing the inbound turn");
    this.name = "QqAgentLifecycleDisposedError";
  }
}

export async function recoverQqCompletedMix(
  runtime: MixingRuntime,
  turn: InboundTurn,
  signal: AbortSignal,
): Promise<CompletedMix | undefined> {
  const recovered = await runtime.resumePending?.({
    sessionId: qqMixSessionId(turn),
    sourceEventId: turn.idempotencyKey,
    expectedDeliveryId: qqAgentDeliveryId(turn),
    signal,
  });
  return recovered
    ? {
      result: recovered.result,
      delivery: recovered.deliveryTarget,
      summary: "plan" in recovered.result ? recovered.result.plan.summary : "当前 REAPER 工程已渲染",
      sessionId: qqMixSessionId(turn),
      }
    : undefined;
}

export async function recordQqAgentDeliveryReceipt(
  context: QqAgentDeliveryContext,
  receipt: DeliveryReceipt,
): Promise<void> {
  if (receipt.deliveryId !== context.deliveryId) {
    throw new Error(`QQ delivery receipt ${receipt.deliveryId} does not match ${context.deliveryId}`);
  }
  if (context.completedMix) {
    await context.runtime.recordDelivery({
      sessionId: context.completedMix.sessionId ?? qqMixSessionId(context.turn),
      sourceEventId: context.turn.idempotencyKey,
      iteration: context.completedMix.result.iteration,
      deliveryId: context.deliveryId,
      status: receipt.status,
      ...(receipt.platformMessageId ? { platformMessageId: receipt.platformMessageId } : {}),
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      artifactId: context.completedMix.result.artifact.artifactId,
    });
  }
}

export async function projectQqAgentDeliveryReceipt(
  context: QqAgentDeliveryContext,
  receipt: DeliveryReceipt,
  onReconciliationRequired: (receipt: DeliveryReceipt) => void,
): Promise<void> {
  try {
    await recordQqAgentDeliveryReceipt(context, receipt);
  } catch (error) {
    onReconciliationRequired(receipt);
    if (context.completedMix && receipt.status === "uncertain") throw error;
  }
}

const mixToolArgsSchema = z.strictObject({
  feedback: z.string().min(1),
  materials: z.array(z.strictObject({
    artifactId: z.string().min(1),
    trackName: z.string().trim().min(1).max(128).refine((value) =>
      [...value].every((character) => (character.codePointAt(0) ?? 0) >= 32 && character !== "\u007f"),
    "trackName must not contain control characters"),
  })).max(16).default([]),
  delivery: z.enum(["source", "default-group"]).default("source"),
  deliveryFormat: z.enum(["mp3", "wav"]).default("mp3"),
});

const renderToolArgsSchema = z.strictObject({
  delivery: z.enum(["source", "default-group"]).default("source"),
  deliveryFormat: z.enum(["mp3", "wav"]).default("mp3"),
});

const unpackToolArgsSchema = z.strictObject({
  archiveArtifactId: z.string().min(1),
});

function availableMaterial(materials: readonly ArtifactRef[], requestedId: string): ArtifactRef | undefined {
  const canonicalId = /^[0-9a-f]{64}$/u.test(requestedId) ? `artifact:${requestedId}` : requestedId;
  return materials.find((artifact) => artifact.artifactId === canonicalId);
}

export function deterministicSessionId(prefix: string, identity: string): string {
  return `${prefix}-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export function installQqAgentModel(
  agentContext: Context,
  selection: { readonly provider: string; readonly model: string },
): void {
  const modelSelection: ModelSelectionRef = {
    current: { ...selection },
    assembled: undefined,
  };
  installModelSelection(agentContext, modelSelection);
}

export type QqAgentAccess = "restricted" | "trusted-private";

export interface KnownQqAgentConversation {
  readonly identity: string;
  readonly access: QqAgentAccess;
}

export function knownQqAgentConversations(
  config: QqAgentPluginConfig,
): readonly KnownQqAgentConversation[] {
  if (!config.accountId) return [];
  const known = new Map<string, QqAgentAccess>();
  for (const userId of config.trustedPrivateUserIds) {
    known.set(`${config.accountId}:private:${userId}`, "trusted-private");
  }
  for (const groupId of new Set([
    ...(config.defaultGroupId ? [config.defaultGroupId] : []),
    ...config.groupIds,
  ])) {
    known.set(`${config.accountId}:group:${groupId}`, "restricted");
  }
  return [...known].map(([identity, access]) => ({ identity, access }));
}

export async function prewarmKnownQqAgentConversations(
  config: QqAgentPluginConfig,
  acquire: (conversation: KnownQqAgentConversation) => Promise<void>,
): Promise<void> {
  for (const conversation of knownQqAgentConversations(config)) {
    await acquire(conversation);
  }
}

export function qqAgentAccess(
  turn: InboundTurn,
  trustedPrivateUserIds: readonly string[],
): QqAgentAccess {
  return turn.channel.conversation.kind === "private"
    && trustedPrivateUserIds.includes(turn.sender.id)
    ? "trusted-private"
    : "restricted";
}

export async function configureQqAgentToolScope(
  hostContext: Context,
  agentContext: Context,
  access: QqAgentAccess,
): Promise<void> {
  await hostContext.agentPresets.mount(agentContext, qqAgentPreset);
  if (access === "trusted-private") {
    agentContext.tools.restrict({ deny: [...qqAgentUiOnlyTools] });
    return;
  }
  agentContext.tools.restrict({
    allow: [...qqAgentInheritedTools],
  });
}

export function configureQqAgentPermissions(
  hostContext: Context,
  agentContext: Context,
  access: QqAgentAccess,
): void {
  if (!agentContext.agent) throw new Error("QQ permission setup requires an agent context");
  hostContext.permissionPresets.set(
    agentContext.agent.session,
    access === "trusted-private" ? "danger-full-access" : "workspace-write",
  );
}

export function buildQqAgentPrompt(
  turn: InboundTurn,
  materials: readonly ArtifactRef[],
  access: QqAgentAccess = "restricted",
  recordedFeedback?: ProjectFeedbackResult,
  passiveContext?: readonly PassiveGroupMessage[],
): string {
  const materialLines = materials.length === 0
    ? "- 当前没有这个 QQ 用户可用的已上传素材。"
    : materials.map((artifact) =>
        `- ${artifact.artifactId} | ${artifact.fileName ?? "未命名文件"} | ${artifact.kind}`).join("\n");
  const accessInstructions = access === "trusted-private"
    ? [
        "这是白名单私聊 operator 会话：你继承当前 DSH 已安装的完整工具与 Skill，可像正常 DSH Agent 一样处理文件、调用工具和完成多步骤任务。",
        "mix_audio 与 unpack_archive 是混音和工程包处理的快捷工具，不是能力上限。其他任务应直接使用当前可用的 DSH 工具；不要声称拥有实际未出现在工具列表中的能力。",
        "需要找以前发送的文件时调用 list_materials；需要丢弃旧处理、从历史素材建立干净 REAPER 工程时调用 rebuild_project，不要用 mix_audio 猜测性清轨。",
        "处理标准 ZIP 工程包时可以用 unpack_archive 快速展开；若用户任务需要其他归档格式、目录操作或后续处理，应按正常 DSH 工作流选择当前可用工具，不要因为快捷工具的输入范围拒绝整个任务。",
        "遇到 REAPER API、ReaScript 实现或宿主行为问题时，先用 reaper_docs MCP 查询本机当前版本的 ReaScript 文档：先 status，未就绪则 refresh，再 search 定位并用 describe_api 核对准确签名。不要靠反复 shell 猜 API，也不要把整份 HTML 读进上下文。",
        "高层混音工具不覆盖 FX 链的增删或替换时，允许自行编写并执行临时 ReaScript/Lua 修改当前 REAPER 工程；不要因为 FabFilter MCP 不提供 mutation 工具而拒绝。",
        "任何 FabFilter FX 链增删或替换前，本轮必须调用 mcp__fabfilter__list_installed，并使用返回的产品、format 和 REAPER 名称，不得凭记忆猜测安装状态。",
        "设置具体 FabFilter 自动化参数前，必须依次调用 mcp__fabfilter__describe 和 mcp__fabfilter__probe，按真实参数面写脚本。",
        "临时脚本必须幂等，并核对预期的当前 FX 链；执行前后都调用 mixing_status 留下工程证据。脚本把修改包在单个 Undo block 内，用 xpcall 捕获失败并在失败时回滚；回滚前必须用 Undo_CanUndo2 核对栈顶是本脚本自己的 block 名，空 block 可能被 REAPER 丢弃，盲目 Undo_DoUndo2 会撤销上一个成功操作（教训：失败脚本的回滚曾把已保存的 ReaEQ→Pro-Q4 迁移整个撤销），再如实回复。",
        "直接 shell/ReaScript 不受 Mixing Runtime mutation queue 保护；执行前确认 bridge idle，不要主动与 mix_audio 并发，并理解其他会话仍可能产生竞态。",
        "同一 QQ 入站可能在重启后重放；若目标状态已经达到，脚本必须 no-op 且不得重复变更；前态不明时停止并报告，不要猜测性执行。",
        "工程创建/重建后的必经确认：先给出分段地图（段落名+起止秒）等 operator 校对，确认前不得写任何按段落的包络开窗；分段冲突先问不猜。",
        "operator 的手动编辑（包络凹陷、推子骑轨等）神圣不可覆盖；批量缩放包络前必须列出窗内所有原始点并逐一核对。",
        "电平步进 0.2dB 起步、单步不超 0.5dB；让人声更清晰优先用让位（伴奏 carve/侧链）而非硬抬。",
        "插件参数写归一化值前必须实测刻度：用 TrackFX_SetParamNormalized + GetFormattedParamValue 扫几个点确认映射（教训：ReaEQ 增益是 0.02 norm=1dB、0.5=0dB，不是 0.0547/dB；猜刻度曾把 -2dB 写成 -5.4dB）。",
        "包络开窗流程：先用 Envelope_Evaluate 取齐所有边界值，再统一 InsertEnvelopePoint/缩放，最后 Envelope_SortPoints；禁止边评估边插入的循环（会产生复利式错误）。",
        "CLI 渲染配置：RENDER_FILE 只写目录、RENDER_PATTERN 写文件名（否则会以文件名为目录名建目录）；渲染前用 osascript 关闭 'REAPER New Version Notification' 和 About 弹窗（模态框会吞掉 42230 渲染命令）。",
        "渲染前探引擎：GetAudioDeviceInfo 输出 '0/4'（Duet 3 输出、无输入）为健康态；若变 0/0，先在偏好设置里重选 Duet 3 输出再渲染。",
        "任何交付版本必须走 render_demo 让版本号、artifact、账本同时落盘；CLI/shell 渲染只允许诊断用。绕开账本手动上传会导致群里『发最新』落后几十个版本。",
      ]
    : [
        "这是群聊或非 operator 会话：只使用当前提供的高层混音工具，不得尝试原始 Computer Use、shell、web 或任意宿主文件操作。",
        "用户明确要求使用 ZIP 压缩包时，先调用 unpack_archive；它会把当前用户已有压缩包中的常见音频和工程附属文件展开到素材工作区。然后用返回的 audio 素材 ID 调用 mix_audio，绝不能把 ZIP 本身交给 mix_audio。",
      ];
  return [
    "你叫“混音牛马”，是常驻 QQ 群的资深混音助手。请用自然、简洁的中文回复。",
    "人格基调：专业、靠谱、活多话少，带一点录音棚打工人的干幽默；可以偶尔自称‘混音牛马’，但不要每句话都玩梗。",
    "对用户耐心友好，不贬低用户，不阴阳怪气，也不为了人设牺牲准确性。不能假装已经试听、混音或渲染；没有证据就明确说明。",
    "单个工具返回错误只是本轮的新证据，不等于宿主要求停止：阅读错误和当前状态后，由你自行决定查文档、换安全方案、继续执行或停止；不要因为第一次工具失败就机械结束。",
    "普通聊天、寒暄、知识问答直接回答，绝对不要调用 mix_audio。",
    "回答混音基础、诊断思路、EQ、压缩、相位、混响或延迟问题时，先调用 mixing_knowledge，并把它作为方法而不是固定参数表；mix_audio 内部会自动使用同一知识包，无需在执行前重复调用。",
    "只有用户明确要求改变声音或执行混音时才调用 mix_audio；不要把‘聊到混音’误判成执行命令。",
    "如果当前工程已经通过 ReaScript、宿主工具或人工操作完成修改，只需要导出试听时调用 render_demo；它只渲染当前已接受的工程，绝对不要再调用 mix_audio 重新分析、规划或改动效果器链。",
    "若调用 mix_audio，把自然语言要求原样放进 feedback。只有用户明确要求使用已上传素材时才选择 materials；每个素材填写独立、可读的 trackName（通常沿用文件名），不得按主唱/和声类别把多人素材合到同一轨。",
    "历史素材不属于当前 REAPER 工程；用 list_materials 可随时重新读取。只有用户明确要求重建工程时才调用 rebuild_project。",
    "导出文件按项目名命名（<项目名>-vNNN.mp3）；用户给项目起名后，把名字写入该会话 audio-work 目录下的 project-name.txt，后续导出自动使用。新建或重建工程前先问用户项目名。CLI/shell 渲染只能用于诊断，不能充当交付版本；手工修改后的正式试听必须调用 render_demo，让版本、音频 artifact 和 ledger 同时落盘。",
    "多项目管理：项目登记处在 runtime/projects/registry.json（name → projectPath/sessionId/当前版本）。用户要求切换项目时：核对登记处 → 用 reaper/switch-project.lua 模板（填 TARGET_PATH）保存当前工程并打开目标 → 切换成功后更新该会话 project-name.txt 与登记处 → 回复确认。前态不明就停下来报告，不要猜。",
    "私聊用户明确要求把回答、结果或文件发群里时，必须调用 send_to_group；如果同时调用 mix_audio，也选择 delivery=default-group。没有明确要求时不要改投群聊。",
    "群聊按工程发试听时调用 send_to_group：把用户说的工程名放入 project；“最新”设置 latest=true，指定版本则设置 version。查询使用全局工程登记，不按当前发言人猜 session。私聊改投默认群，群聊发回当前群。绝对不要为重发而重新渲染。",
    "群聊里要 @ 某人时，在回复文本里写 [@QQ号]（如 [@123456]），系统会自动转成真正的 at 并把标记从文字里移除；QQ 号从上下文消息的发言人标注或反馈记录里取，猜不到就不 @。追问某人的反馈时优先 @ 本人。",
    "汇总或转述反馈时必须注明提出人（昵称），不得把多人意见揉成一团无主综述；意见冲突时如实并列呈现。",
    ...(recordedFeedback ? [
      `当前消息已自动登记为工程 ${recordedFeedback.projectName} v${String(recordedFeedback.iteration).padStart(3, "0")} 的试听反馈。反馈不是存档就完事，要把需求聊清楚：确认已记录后，主动追问缺失的关键信息——具体时间点/段落（"3分40秒左右"而不是"后面"）、哪个声部或乐器、期望方向（更突出/更收敛/参考哪首歌）；反馈本身已经具体完整时才只确认不追问。除非用户明确要求据此生成下一版，否则不要调用 mix_audio。`,
    ] : []),
    "试听交付默认 MP3（deliveryFormat=mp3）；只有用户明确要求 WAV 时才选择 deliveryFormat=wav。",
    "QQ 会话没有网页交互接管：不得调用 ask_user_question 或任何等待网页回答的工具。信息足够时自行采用合理默认并执行；确有关键歧义时，用普通文本提出一个简短问题并结束本轮。",
    "最终回复会由通信层自动用 QQ 原生引用回复当前入站消息；不要自行调用 NapCat、curl 或 shell 查消息 ID、发送消息。",
    ...accessInstructions,
    "使用 mix_audio 修改工程时，混音参数、素材导入和渲染仍走确定性 REAPER 桥接。",
    ...(passiveContext && passiveContext.length > 0 ? [
      "以下是最近群里未 @ 你的消息（仅供上下文，绝对不要逐条回复它们、不要假装被问到；只有当前入站消息需要你回应）：",
      ...passiveContext.map((m) => `- [${m.occurredAt}] ${m.senderName}（QQ:${m.senderId}）: ${m.text}`),
    ] : []),
    `来源会话：${turn.channel.conversation.kind}:${turn.channel.conversation.id}`,
    `当前入站消息 ID：${turn.messageId}`,
    `用户消息：${turn.text || "（仅上传附件）"}`,
    "该 QQ 用户可复用的素材：",
    materialLines,
  ].join("\n");
}

export function createQqUnpackTool(
  artifactStore: LocalArtifactStore,
  catalog: JsonlMaterialCatalog,
  activeTurnForAgent: (agentId: string) => ActiveTurn | undefined,
  onExpanded: (agentId: string, materials: readonly ArtifactRef[]) => void,
) {
  return defineTool({
    name: "unpack_archive",
    description: "Expand one ZIP already owned by the current QQ user into the dedicated material workspace. Call when the user asks to use or unpack that archive.",
    parameters: {
      archiveArtifactId: {
        type: "string",
        required: true,
        description: "The exact ZIP artifact identity shown in the prompt. Preserve its artifact: prefix.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          archiveArtifactId: { type: "string", required: true },
          materials: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                artifactId: { type: "string", required: true },
                fileName: { type: "string", required: true },
                kind: { type: "string", enum: ["audio", "file"], required: true },
                bytes: { type: "integer", required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(rawArgs, exec) {
      const args = unpackToolArgsSchema.parse(rawArgs);
      const agentId = String(exec.agent?.id ?? "");
      const active = activeTurnForAgent(agentId);
      if (!active) throw new Error("unpack_archive has no active QQ turn");
      const archive = availableMaterial(active.availableMaterials, args.archiveArtifactId);
      if (!archive) throw new Error(`archive ${args.archiveArtifactId} is not available to this QQ user`);
      const expanded = await artifactStore.expandZipArchive(archive, exec.signal);
      for (const artifact of expanded) {
        await catalog.remember({
          accountId: active.turn.channel.accountId ?? "unknown",
          ownerId: active.turn.sender.id,
          messageId: active.turn.messageId,
          artifact,
        });
      }
      onExpanded(agentId, expanded);
      return {
        archiveArtifactId: archive.artifactId,
        materials: expanded.map((artifact) => ({
          artifactId: artifact.artifactId,
          fileName: artifact.fileName ?? "unnamed.wav",
          kind: artifact.kind,
          bytes: artifact.bytes ?? 0,
        })),
      };
    },
  });
}

const groupDeliveryArgsSchema = z.strictObject({
  project: z.string().trim().min(1).max(80).optional(),
  version: z.number().int().positive().optional(),
  latest: z.boolean().default(false),
});

export function createQqGroupDeliveryTool(
  runtime: MixingRuntime,
  activeTurnForAgent: (agentId: string) => ActiveTurn | undefined,
  onSelected: (agentId: string, delivery: QqAgentDeliveryTarget) => void,
  onCompleted: (agentId: string, mix: CompletedMix) => void,
) {
  return defineTool({
    name: "send_to_group",
    description: "Send a registered project's latest or named render into the current/default QQ group. Project lookup is shared across QQ users and conversations. Historical redelivery never renders again.",
    parameters: {
      project: {
        type: "string",
        description: "Registered project name, for example everytime. In group chat, provide this whenever the user names a project.",
      },
      version: {
        type: "number",
        description: "Existing demo version number (e.g. 17) to redeliver from the session ledger. No re-render happens. Omit when this turn rendered fresh audio via mix_audio/render_demo.",
      },
      latest: {
        type: "boolean",
        description: "Redeliver the newest already-rendered artifact from this QQ sender's shared mixing ledger. Use for requests such as 发一下最新渲染版本.",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          delivery: { type: "string", enum: ["source", "default-group"], required: true },
          version: { type: "integer" },
          latest: { type: "boolean" },
          project: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(rawArgs, exec) {
      const args = groupDeliveryArgsSchema.parse(rawArgs);
      const agentId = String(exec.agent?.id ?? "");
      const active = activeTurnForAgent(agentId);
      if (!active) throw new Error("send_to_group has no active QQ turn");
      if (args.version !== undefined && args.latest) {
        throw new Error("send_to_group accepts either version or latest, not both");
      }
      const isPrivate = isPrivateQqTurn(active.turn);
      if (!isPrivate && args.project === undefined && (args.version !== undefined || args.latest)) {
        throw new Error("群聊重发渲染必须指定已登记的工程名");
      }
      if (args.version !== undefined || args.latest || args.project !== undefined) {
        const projectFound = args.project === undefined
          ? undefined
          : await runtime.findProjectRendered?.(args.project, args.version);
        const found = projectFound ?? (args.project === undefined
          ? args.version !== undefined
            ? await runtime.findRenderedVersion?.(qqMixSessionId(active.turn), args.version)
            : await runtime.findLatestRendered?.(qqMixSessionId(active.turn))
          : undefined);
        if (!found) {
          const label = args.project ? `工程 ${args.project}` : "当前工程";
          throw new Error(args.version !== undefined
            ? `没有找到 ${label} 已渲染的 v${String(args.version).padStart(3, "0")}，请确认工程名和版本号`
            : `没有找到 ${label} 可重发的历史渲染版本`);
        }
        const delivery: QqAgentDeliveryTarget = isPrivate ? "default-group" : "source";
        // Mark delivery only AFTER lookup succeeds so a failed private lookup
        // cannot leak the private final reply into the group.
        onSelected(agentId, delivery);
        onCompleted(agentId, {
          result: found,
          delivery,
          summary: `重发 ${found.rendered.fileName.replace(/\.wav$/u, "")}`,
          sessionId: projectFound?.sessionId ?? qqMixSessionId(active.turn),
        });
        return {
          delivery,
          ...(args.project ? { project: projectFound?.projectName ?? args.project } : {}),
          ...(args.version !== undefined ? { version: args.version } : { latest: true as const }),
        };
      }
      if (!isPrivate) {
        throw new Error("send_to_group without version/latest is available only for private QQ turns");
      }
      onSelected(agentId, "default-group");
      return { delivery: "default-group" as const };
    },
  });
}

export function createQqMixTool(
  runtime: MixingRuntime,
  activeTurnForAgent: (agentId: string) => ActiveTurn | undefined,
  onCompleted: (agentId: string, mix: CompletedMix) => void,
  observer?: QqMixToolObserver,
) {
  return defineTool({
    name: "mix_audio",
    description: "Apply an explicit natural-language mixing request in REAPER and render a delivery preview. Defaults to 320 kbps MP3; use WAV only when explicitly requested. Never call for ordinary chat.",
    parameters: {
      feedback: { type: "string", required: true, description: "The user's explicit mixing request." },
      materials: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            artifactId: {
              type: "string",
              required: true,
              description: "The exact artifact identity shown in the prompt. Preserve its artifact: prefix.",
            },
            trackName: {
              type: "string",
              required: true,
              description: "A distinct human-readable source track label, usually the material file name without its extension. Do not reuse a label to collapse performers or parts.",
            },
          },
        },
      },
      delivery: { type: "string", enum: ["source", "default-group"] },
      deliveryFormat: { type: "string", enum: ["mp3", "wav"] },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          iteration: { type: "integer", required: true },
          summary: { type: "string", required: true },
          artifactId: { type: "string", required: true },
          delivery: { type: "string", required: true },
          deliveryFormat: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(rawArgs, exec) {
      const args = mixToolArgsSchema.parse(rawArgs);
      const agentId = String(exec.agent?.id ?? "");
      const attempt = observer?.started(agentId) ?? 0;
      const active = activeTurnForAgent(agentId);
      if (!active) throw new Error("mix_audio has no active QQ turn");
      if (args.delivery === "default-group" && !isPrivateQqTurn(active.turn)) {
        throw new Error("default group delivery is available only for private QQ turns");
      }
      const requestedTrackNames = new Set<string>();
      const requestedArtifactIds = new Set<string>();
      const inputArtifacts: AssignedInputArtifact[] = args.materials.map(({ artifactId, trackName }) => {
        const artifact = availableMaterial(active.availableMaterials, artifactId);
        if (!artifact) throw new Error(`material ${artifactId} is not available to this QQ user`);
        if (artifact.kind !== "audio") {
          throw new Error(`material ${artifactId} is not audio; unpack ZIP archives before mixing`);
        }
        if (requestedArtifactIds.has(artifact.artifactId)) {
          throw new Error(`material ${artifact.artifactId} is assigned more than once`);
        }
        requestedArtifactIds.add(artifact.artifactId);
        const identity = trackName.normalize("NFC").toLocaleLowerCase("en-US");
        if (requestedTrackNames.has(identity)) {
          throw new Error(`materials must use distinct track names; duplicate: ${trackName}`);
        }
        requestedTrackNames.add(identity);
        return { artifact, trackName };
      });
      let result: MixingRuntimeResult;
      try {
        result = await runtime.run({
          sessionId: qqMixSessionId(active.turn),
          sourceEventId: active.turn.idempotencyKey,
          expectedDeliveryId: qqAgentDeliveryId(active.turn),
          deliveryFormat: args.deliveryFormat,
          deliveryTarget: args.delivery,
          text: args.feedback,
          actor: {
            platform: "qq",
            id: active.turn.sender.id,
            ...(active.turn.sender.displayName ? { displayName: active.turn.sender.displayName } : {}),
          },
          inputArtifacts,
          signal: exec.signal,
        });
      } catch (error) {
        if (error instanceof LlmError) {
          const retryable = retryableInboundFailure(error.failure);
          if (retryable) observer?.retryableFailure(agentId, attempt, retryable);
        }
        throw error;
      }
      observer?.completed(agentId, attempt);
      onCompleted(agentId, {
        result,
        delivery: args.delivery,
        summary: result.plan.summary,
        sessionId: qqMixSessionId(active.turn),
      });
      return {
        iteration: result.iteration,
        summary: result.plan.summary,
        artifactId: result.artifact.artifactId,
        delivery: args.delivery,
        deliveryFormat: args.deliveryFormat,
      };
    },
  });
}

export function createQqRenderTool(
  runtime: MixingRuntime,
  activeTurnForAgent: (agentId: string) => ActiveTurn | undefined,
  onCompleted: (agentId: string, render: CompletedMix) => void,
) {
  return defineTool({
    name: "render_demo",
    description: "Render and publish the current accepted REAPER project without analyzing, planning, importing media, or changing the mix. Use after manual ReaScript or host edits are already complete.",
    parameters: {
      delivery: { type: "string", enum: ["source", "default-group"] },
      deliveryFormat: { type: "string", enum: ["mp3", "wav"] },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          iteration: { type: "integer", required: true },
          artifactId: { type: "string", required: true },
          delivery: { type: "string", required: true },
          deliveryFormat: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(rawArgs, exec) {
      const args = renderToolArgsSchema.parse(rawArgs);
      const agentId = String(exec.agent?.id ?? "");
      const active = activeTurnForAgent(agentId);
      if (!active) throw new Error("render_demo has no active QQ turn");
      if (args.delivery === "default-group" && !isPrivateQqTurn(active.turn)) {
        throw new Error("default group delivery is available only for private QQ turns");
      }
      if (!runtime.renderPreview) {
        throw new Error("RMA_RENDER_UNAVAILABLE: mixing runtime has no render-only entry point");
      }
      const result = await runtime.renderPreview({
        sessionId: qqMixSessionId(active.turn),
        sourceEventId: active.turn.idempotencyKey,
        expectedDeliveryId: qqAgentDeliveryId(active.turn),
        deliveryFormat: args.deliveryFormat,
        deliveryTarget: args.delivery,
        actor: {
          platform: "qq",
          id: active.turn.sender.id,
          ...(active.turn.sender.displayName ? { displayName: active.turn.sender.displayName } : {}),
        },
        signal: exec.signal,
      });
      onCompleted(agentId, {
        result,
        delivery: args.delivery,
        summary: "当前 REAPER 工程已渲染",
        sessionId: qqMixSessionId(active.turn),
      });
      return {
        iteration: result.iteration,
        artifactId: result.artifact.artifactId,
        delivery: args.delivery,
        deliveryFormat: args.deliveryFormat,
      };
    },
  });
}

function assistantText(handle: AgentHandle, excludedMessageIds: ReadonlySet<string>): string {
  const message = [...handle.agent.session.deriveMessages()].reverse().find((candidate) =>
    candidate.role === "assistant" && !excludedMessageIds.has(String(candidate.id)));
  if (!message) return "";
  return message.content.flatMap((block) =>
    block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n").trim();
}

function completedSummary(completed: CompletedMix): string {
  if (completed.summary) return completed.summary;
  return "plan" in completed.result ? completed.result.plan.summary : "当前 REAPER 工程已渲染";
}

export function assertQqAgentTurnSucceeded(events: readonly SessionEvent[]): void {
  const outcome = foldConsumedWork(events);
  if (outcome.droppedUnrun) {
    throw new Error("QQ agent turn was cancelled before it ran");
  }
  const reason = outcome.end?.data.reason;
  if (!reason) {
    throw new Error("QQ agent turn ended without a durable outcome");
  }
  if (reason.kind === "completed") return;
  if (reason.kind === "error") {
    const retryable = retryableInboundFailure(reason.error);
    if (retryable) throw retryable;
    throw new Error(`QQ agent turn failed: ${reason.error.message}`);
  }
  if (reason.kind === "aborted" && reason.reason.kind === "disposed") {
    throw new QqAgentLifecycleDisposedError();
  }
  throw new Error(`QQ agent turn ended with ${reason.kind}`);
}

function retryableInboundFailure(failure: LlmFailure): RetryableInboundError | undefined {
  if (failure.code !== "RATE_LIMIT" && failure.code !== "QUOTA") return undefined;
  const label = failure.code === "QUOTA" ? "quota exhausted" : "rate limited";
  return new RetryableInboundError(`QQ agent provider ${label}: ${failure.message}`, {
    ...(failure.providerRetryAfterMs === undefined
      ? {}
      : { retryAfterMs: failure.providerRetryAfterMs }),
    ...(failure.code === "QUOTA" ? { resumePolicy: "manual" as const } : {}),
    cause: failure,
  });
}

export async function apply(context: Context, config: QqAgentPluginConfig): Promise<() => Promise<void>> {
  const local = await loadConfig(config.configPath);
  const catalog = new JsonlMaterialCatalog(join(local.paths.runtimeRoot, "communication", "qq", "materials.jsonl"));
  const artifactStore = new LocalArtifactStore(join(local.paths.audioWorkRoot, "qq-imports"));
  const handles = new Map<string, AgentHandle>();
  const activeTurns = new Map<string, ActiveTurn>();
  const completedMixes = new Map<string, CompletedMix>();
  const retryableMixFailures = createQqMixFailureTracker();
  const selectedDeliveries = new Map<string, QqAgentDeliveryTarget>();
  const docsGates = new Map<string, ReaperDocsEvidenceGate>();
  const turnDrain = createQqAgentTurnDrain();
  const logger = context.logger(name);

  const deliverReply = async (
    turn: InboundTurn,
    completedMix: CompletedMix | undefined,
    delivery: QqAgentDeliveryTarget,
    text: string,
    onDeliveryStart: () => void,
    signal: AbortSignal,
  ): Promise<void> => {
    const target = qqAgentReplyTarget(turn, config.defaultGroupId, delivery);
    const deliveryId = qqAgentDeliveryId(turn);
    const { text: cleanText, mentions } = extractQqMentions(text);
    let receipt: DeliveryReceipt;
    try {
      onDeliveryStart();
      receipt = await context.communication.deliver({
        schema: "rma.outbound-message/v1",
        deliveryId,
        target,
        text: cleanText,
        artifacts: completedMix ? [completedMix.result.artifact] : [],
        settlesInboundIdempotencyKey: turn.idempotencyKey,
        ...(mentions.length > 0 ? { mentions: [...mentions] } : {}),
        replyToMessageId: target.conversation.kind === turn.channel.conversation.kind
          && target.conversation.id === turn.channel.conversation.id ? turn.messageId : undefined,
        ...(completedMix ? {
          correlation: {
            sessionId: completedMix.sessionId ?? qqMixSessionId(turn),
            iteration: completedMix.result.iteration,
          },
        } : {}),
      }, signal);
    } catch (error) {
      if (completedMix) {
        await context.mixingRuntime.recordDelivery({
          sessionId: completedMix.sessionId ?? qqMixSessionId(turn),
          sourceEventId: turn.idempotencyKey,
          iteration: completedMix.result.iteration,
          deliveryId,
          status: "uncertain",
          errorCode: "RMA_DELIVERY_UNCERTAIN",
          artifactId: completedMix.result.artifact.artifactId,
        });
      }
      throw error;
    }
    await projectQqAgentDeliveryReceipt({
      runtime: context.mixingRuntime,
      turn,
      ...(completedMix ? { completedMix } : {}),
      deliveryId,
    }, receipt, (unprojected) => {
      logger.error(
        "QQ delivery settled but mixing projection needs reconciliation: %s %s",
        deliveryId,
        unprojected.status,
      );
    });
  };

  const getHandleForIdentity = async (
    identity: string,
    access: QqAgentAccess,
  ): Promise<AgentHandle> => {
    const sessionId = deterministicSessionId(qqAgentSessionNamespace, identity);
    const existing = handles.get(sessionId);
    if (existing) return existing;
    const setup = async (agentContext: Context) => {
      if (local.llm) installQqAgentModel(agentContext, local.llm.default);
      await configureQqAgentToolScope(context, agentContext, access);
      configureQqAgentPermissions(context, agentContext, access);
      if (access === "trusted-private" && agentContext.agent) {
        const docsGate = createReaperDocsEvidenceGate();
        const agentId = String(agentContext.agent.id);
        docsGates.set(agentId, docsGate);
        agentContext.tools.guard(docsGate.guard);
        agentContext.on("tools/result", (
          execution: Readonly<ToolExecution>,
          result: Readonly<ToolExecutionResult>,
        ) => { docsGate.observe(execution, result); });
      }
      agentContext.tools.register(createQqUnpackTool(
        artifactStore,
        catalog,
        (agentId) => activeTurns.get(agentId),
        (agentId, expanded) => {
          const active = activeTurns.get(agentId);
          if (!active) return;
          const available = new Map(active.availableMaterials.map((artifact) => [artifact.artifactId, artifact]));
          for (const artifact of expanded) available.set(artifact.artifactId, artifact);
          activeTurns.set(agentId, { ...active, availableMaterials: [...available.values()] });
        },
      ));
      agentContext.tools.register(createQqMixTool(
        context.mixingRuntime,
        (agentId) => activeTurns.get(agentId),
        (agentId, mix) => { completedMixes.set(agentId, mix); },
        retryableMixFailures,
      ));
      agentContext.tools.register(createQqRenderTool(
        context.mixingRuntime,
        (agentId) => activeTurns.get(agentId),
        (agentId, render) => { completedMixes.set(agentId, render); },
      ));
      agentContext.tools.register(createQqGroupDeliveryTool(
        context.mixingRuntime,
        (agentId) => activeTurns.get(agentId),
        (agentId, delivery) => { selectedDeliveries.set(agentId, delivery); },
        (agentId, mix) => { completedMixes.set(agentId, mix); },
      ));
      const scopeForAgent = (agentId: string) => {
        const active = activeTurns.get(agentId);
        return active?.turn.channel.accountId
          ? { accountId: active.turn.channel.accountId, ownerId: active.turn.sender.id }
          : undefined;
      };
      agentContext.tools.register(createMaterialLibraryTool(catalog, scopeForAgent));
      agentContext.tools.register(createProjectRebuildTool(context.projectManager, scopeForAgent));
    };
    const persisted = await context.get("sessionPersistence")?.list();
    const hasPersistedSession = persisted?.some((header: { readonly id: string }) => header.id === sessionId) ?? false;
    const handle = hasPersistedSession
      ? await context.agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: { ...local.llm?.default },
          setup,
        })
      : await context.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: process.cwd(), agentPreset: qqAgentPreset },
          agentOptions: { ...local.llm?.default },
          setup,
        });
    handles.set(sessionId, handle);
    return handle;
  };

  const getHandle = async (turn: InboundTurn): Promise<AgentHandle> => {
    const identity = `${turn.channel.accountId ?? "unknown"}:${turn.channel.conversation.kind}:${turn.channel.conversation.id}`;
    return await getHandleForIdentity(identity, qqAgentAccess(turn, config.trustedPrivateUserIds));
  };

  // Reserve every configured QQ session before the web server can lazily resume
  // it for a browser viewer. QQ needs the owner handle because its scoped tools,
  // permissions and delivery correlation are installed during setup.
  await prewarmKnownQqAgentConversations(config, async ({ identity, access }) => {
    await getHandleForIdentity(identity, access);
  });

  const unsubscribe = context.communication.subscribe((turn, signal) => turnDrain.run(async () => {
    signal.throwIfAborted();
    if (turn.channel.kind !== "qq" || !turn.channel.accountId) return;
    let normalDeliveryStarted = false;
    try {
      for (const artifact of turn.attachments) {
        if (artifact.availability === "available") {
          await catalog.remember({
            accountId: turn.channel.accountId,
            ownerId: turn.sender.id,
            messageId: turn.messageId,
            artifact,
          });
        }
      }
      const materials = await catalog.list(turn.channel.accountId, turn.sender.id);
      const recordedFeedback = turn.replyTo && context.mixingRuntime.recordProjectFeedback
        ? await context.mixingRuntime.recordProjectFeedback({
            platformMessageId: turn.replyTo.messageId,
            sourceEventId: turn.idempotencyKey,
            messageId: turn.messageId,
            text: turn.text,
            actor: {
              platform: "qq",
              id: turn.sender.id,
              ...(turn.sender.displayName ? { displayName: turn.sender.displayName } : {}),
            },
          })
        : undefined;
      const recoveredMix = await recoverQqCompletedMix(context.mixingRuntime, turn, signal);
      if (recoveredMix) {
        await deliverReply(
          turn,
          recoveredMix,
          recoveredMix.delivery,
          `第 ${recoveredMix.result.iteration} 版已完成：${completedSummary(recoveredMix)}`,
          () => { normalDeliveryStarted = true; },
          signal,
        );
        return;
      }
      const handle = await getHandle(turn);
      const agentId = String(handle.agent.id);
      docsGates.get(agentId)?.reset();
      activeTurns.set(agentId, { turn, availableMaterials: materials });
      completedMixes.delete(agentId);
      retryableMixFailures.clear(agentId);
      selectedDeliveries.delete(agentId);
      try {
        const priorMessages = new Set(handle.agent.session.deriveMessages().map((message) => String(message.id)));
        const firstTurnEventSeq = handle.agent.session.seq;
        const access = qqAgentAccess(turn, config.trustedPrivateUserIds);
        const passiveContext = turn.channel.conversation.kind === "group"
          ? context.communication.recentPassiveMessages?.(turn.channel.conversation.id, 12)
          : undefined;
        handle.agent.followup(createUserMessage({
          content: [{ type: "text", text: buildQqAgentPrompt(turn, materials, access, recordedFeedback, passiveContext) }],
          source: { kind: "plugin", plugin: name },
        }));
        await handle.agent.whenIdle();
        const retryableMixFailure = retryableMixFailures.pending(agentId);
        if (retryableMixFailure) throw retryableMixFailure;
        assertQqAgentTurnSucceeded(handle.agent.session.events.slice(firstTurnEventSeq));
        const completedByTool = completedMixes.get(agentId);
        const recoveredAfterAgent = completedByTool
          ? undefined
          : await recoverQqCompletedMix(context.mixingRuntime, turn, signal);
        const completedMix = completedByTool ?? recoveredAfterAgent;
        const text = recoveredAfterAgent
          ? `第 ${recoveredAfterAgent.result.iteration} 版已完成：${completedSummary(recoveredAfterAgent)}`
          : assistantText(handle, priorMessages) || (completedMix
          ? `第 ${completedMix.result.iteration} 版已完成：${completedSummary(completedMix)}`
          : "混音牛马在。你可以直接聊天，也可以用自然语言告诉我需要怎样混音。");
        const delivery = selectedDeliveries.get(agentId) ?? completedMix?.delivery ?? "source";
        await deliverReply(
          turn,
          completedMix,
          delivery,
          text,
          () => { normalDeliveryStarted = true; },
          signal,
        );
      } finally {
        activeTurns.delete(agentId);
        completedMixes.delete(agentId);
        retryableMixFailures.clear(agentId);
        selectedDeliveries.delete(agentId);
      }
    } catch (error) {
      if (normalDeliveryStarted) throw error;
      await handleQqAgentTurnFailure(context.communication, turn, error, signal);
    }
  }));

  return async () => {
    unsubscribe();
    await turnDrain.drain();
    await Promise.all([...handles.values()].map((handle) => handle.dispose()));
    handles.clear();
  };
}
