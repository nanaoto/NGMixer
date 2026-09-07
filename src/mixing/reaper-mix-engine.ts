import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import {
  requireSuccessfulBridgeResult,
  type BridgeOperation,
  type BridgeReceipt,
  type JsonValue,
} from "../bridge/protocol.js";
import { BridgeSpool } from "../bridge/spool.js";
import type {
  AppliedMixAdjustment,
  DemoRenderer,
  MixEngine,
  MixRunRequest,
  MixRunResult,
  RenderedDemoArtifact,
} from "./execution.js";
import type { MixAction, MixPlan } from "./intent-compiler.js";

export interface BridgeRequest {
  readonly sessionId: string;
  readonly operation: BridgeOperation;
  readonly payload: JsonValue;
  readonly timeoutMs: number;
  readonly expectedProjectId?: string;
}

export interface BridgeRequester {
  request(request: BridgeRequest): Promise<BridgeReceipt>;
}

export class SpoolBridgeRequester implements BridgeRequester {
  public constructor(private readonly spool: BridgeSpool) {}

  public async request(request: BridgeRequest): Promise<BridgeReceipt> {
    const command = await this.spool.submitCommand({
      sessionId: request.sessionId,
      operation: request.operation,
      timeoutMs: request.timeoutMs,
      payload: request.payload,
      ...(request.expectedProjectId === undefined ? {} : { expectedProjectId: request.expectedProjectId }),
    });
    return this.spool.waitForReceipt(command.command_id, request.timeoutMs);
  }
}

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
});

const transactionResultSchema = z.strictObject({
  projectId: z.string().min(1),
  adjustments: z.array(adjustmentSchema),
});

const projectIdentitySchema = z.object({
  project_id: z.string().min(1),
  project_change_count: z.number().int().nonnegative(),
});

const renderResultSchema = z.strictObject({
  path: z.string().min(1),
  sampleRate: z.literal(48_000),
  channels: z.literal(2),
  format: z.literal("wav"),
});

export interface ReaperMixEngineOptions {
  readonly requester: BridgeRequester;
  readonly audioWorkRoot: string;
  readonly commandTimeoutMs?: number;
  readonly renderTimeoutMs?: number;
}

function restorationAction(action: MixAction, adjustment: AppliedMixAdjustment): MixAction {
  const reason = `Rollback: ${action.reason}`;
  if (action.type === "track.gain.delta" || action.type === "send.gain.delta") {
    return { ...action, deltaDb: adjustment.before - adjustment.after, reason };
  }
  return { ...action, deltaNormalized: adjustment.before - adjustment.after, reason };
}

function rollbackPlan(plan: MixPlan, adjustments: readonly AppliedMixAdjustment[]): MixPlan {
  const actions = plan.actions.map((action, actionIndex) => {
    const adjustment = adjustments.find((candidate) => candidate.actionIndex === actionIndex);
    if (!adjustment) throw new Error(`transaction receipt omitted adjustment ${actionIndex}`);
    return restorationAction(action, adjustment);
  }).reverse();
  return {
    schema: "rma.mix-plan/v2",
    sourceEventId: `${plan.sourceEventId}:render-rollback`,
    sourceText: "automatic rollback after render failure",
    summary: `Rollback: ${plan.summary}`,
    actions,
  };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Versioned demo file prefix. A session may declare a project display name via
 * <audioWorkRoot>/<sessionId>/project-name.txt (written by the operator/agent
 * when the user names the project); falls back to "demo".
 */
async function sessionProjectPrefix(audioWorkRoot: string, sessionId: string): Promise<string> {
  try {
    const raw = await readFile(join(audioWorkRoot, sessionId, "project-name.txt"), "utf8");
    const clean = raw.trim()
      .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "");
    return clean.length > 0 && clean.length <= 40 ? clean : "demo";
  } catch {
    return "demo";
  }
}

/**
 * Optional version floor: when delivery history outran the ledger (e.g. manual
 * shell renders), <session>/version-floor.txt pins the minimum version number so
 * ledger-derived iterations can never name a file below already-delivered work.
 */
async function sessionVersionFloor(audioWorkRoot: string, sessionId: string): Promise<number> {
  try {
    const raw = await readFile(join(audioWorkRoot, sessionId, "version-floor.txt"), "utf8");
    const parsed = Number(raw.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

export class ReaperMixEngine implements MixEngine, DemoRenderer {
  public constructor(private readonly options: ReaperMixEngineOptions) {}

  public async run(request: MixRunRequest): Promise<MixRunResult> {
    this.#validateRenderRequest(request.sessionId, request.iteration);
    const snapshotReceipt = await this.options.requester.request({
      sessionId: request.sessionId,
      operation: "project.snapshot",
      timeoutMs: this.options.commandTimeoutMs ?? 30_000,
      payload: {},
    });
    const snapshot = projectIdentitySchema.parse(requireSuccessfulBridgeResult(snapshotReceipt, "project.snapshot"));
    const transactionReceipt = await this.options.requester.request({
      sessionId: request.sessionId,
      operation: "transaction.execute",
      expectedProjectId: snapshot.project_id,
      timeoutMs: this.options.commandTimeoutMs ?? 30_000,
      payload: request.plan as unknown as JsonValue,
    });
    const transaction = transactionResultSchema.parse(
      requireSuccessfulBridgeResult(transactionReceipt, "transaction.execute"),
    );
    if (transaction.projectId !== snapshot.project_id) throw new Error("REAPER transaction changed project identity");
    try {
      await request.recordAdjustments(transaction.adjustments, "applied");
      return {
        adjustments: transaction.adjustments,
        artifact: await this.#renderProject(
          request.sessionId,
          request.iteration,
          transaction.projectId,
          `${snapshot.project_id}@${snapshot.project_change_count}`,
        ),
      };
    } catch (renderError) {
      try {
        const compensationReceipt = await this.options.requester.request({
          sessionId: request.sessionId,
          operation: "transaction.execute",
          expectedProjectId: transaction.projectId,
          timeoutMs: this.options.commandTimeoutMs ?? 30_000,
          payload: rollbackPlan(request.plan, transaction.adjustments) as unknown as JsonValue,
        });
        const compensation = transactionResultSchema.parse(
          requireSuccessfulBridgeResult(compensationReceipt, "transaction.execute"),
        );
        await request.recordAdjustments(compensation.adjustments, "rollback");
      } catch (rollbackError) {
        throw new AggregateError([renderError, rollbackError], "render failed and automatic rollback also failed");
      }
      throw renderError;
    }
  }

  public async render(request: { readonly sessionId: string; readonly iteration: number }): Promise<RenderedDemoArtifact> {
    this.#validateRenderRequest(request.sessionId, request.iteration);
    const snapshotReceipt = await this.options.requester.request({
      sessionId: request.sessionId,
      operation: "project.snapshot",
      timeoutMs: this.options.commandTimeoutMs ?? 30_000,
      payload: {},
    });
    const snapshot = projectIdentitySchema.parse(requireSuccessfulBridgeResult(snapshotReceipt, "project.snapshot"));
    return this.#renderProject(
      request.sessionId,
      request.iteration,
      snapshot.project_id,
      `${snapshot.project_id}@${snapshot.project_change_count}`,
    );
  }

  public async probeProjectRevision(): Promise<string> {
    const snapshotReceipt = await this.options.requester.request({
      sessionId: "revision-probe",
      operation: "project.snapshot",
      timeoutMs: this.options.commandTimeoutMs ?? 30_000,
      payload: {},
    });
    const snapshot = projectIdentitySchema.parse(requireSuccessfulBridgeResult(snapshotReceipt, "project.snapshot"));
    return `${snapshot.project_id}@${snapshot.project_change_count}`;
  }

  #validateRenderRequest(sessionId: string, iteration: number): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new TypeError("session id must be a filename-safe identifier");
    }
    if (!Number.isInteger(iteration) || iteration < 1) {
      throw new TypeError("iteration must be a positive integer");
    }
  }

  async #renderProject(
    sessionId: string,
    iteration: number,
    projectId: string,
    projectRevision: string,
  ): Promise<RenderedDemoArtifact> {
    const outputPath = join(
      this.options.audioWorkRoot,
      sessionId,
      "renders",
      `iteration-${String(iteration).padStart(4, "0")}-${randomUUID()}`,
      "demo.wav",
    );
    await mkdir(dirname(outputPath), { recursive: true });
    const renderReceipt = await this.options.requester.request({
      sessionId,
      operation: "render.create",
      expectedProjectId: projectId,
      timeoutMs: this.options.renderTimeoutMs ?? 300_000,
      payload: {
        outputPath,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        tailSeconds: 2,
      },
    });
    const rendered = renderResultSchema.parse(requireSuccessfulBridgeResult(renderReceipt, "render.create"));
    if (rendered.path !== outputPath) throw new Error("REAPER rendered outside the assigned artifact path");
    const file = await stat(outputPath);
    if (!file.isFile() || file.size === 0) throw new Error("REAPER render artifact is empty");
    const sha256 = await fileSha256(outputPath);
    // Project-name prefix: session may declare a display name (e.g. the song title).
    const prefix = await sessionProjectPrefix(this.options.audioWorkRoot, sessionId);
    const versionFloor = await sessionVersionFloor(this.options.audioWorkRoot, sessionId);
    const versioned = (n: number) => Math.max(n, versionFloor + 1);
    // Content-dedupe naming: audio identical to the previous render keeps that version label.
    let fileName = `${prefix}-v${String(versioned(iteration)).padStart(3, "0")}.wav`;
    try {
      const rendersDir = join(this.options.audioWorkRoot, sessionId, "renders");
      const previousDirs = (await readdir(rendersDir))
        .filter((entry) => /^iteration-\d{4}-/u.test(entry) && entry !== basename(dirname(outputPath)))
        .sort()
        .reverse();
      const newest = previousDirs[0];
      if (newest) {
        const previousPath = join(rendersDir, newest, "demo.wav");
        const previous = await stat(previousPath).catch(() => undefined);
        if (previous?.isFile() && await fileSha256(previousPath) === sha256) {
          const match = newest.match(/^iteration-(\d{4})-/u);
          if (match) fileName = `${prefix}-v${String(versioned(Number(match[1]))).padStart(3, "0")}.wav`;
        }
      }
    } catch { /* naming fallback: keep iteration-based name */ }
    return {
      projectId,
      path: outputPath,
      fileName,
      sampleRate: rendered.sampleRate,
      channels: rendered.channels,
      format: rendered.format,
      bytes: file.size,
      sha256,
      renderBounds: "entire-project",
      tailSeconds: 2,
      projectRevision,
    };
  }
}
