import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { requireSuccessfulBridgeResult } from "../bridge/protocol.js";
import type { BridgeRequester } from "./reaper-mix-engine.js";

// Meter readings may be -Infinity for silent tracks (e.g. a reverb return with
// no input at capture time); clamp anything non-finite or out of range.
const meterValue = z.number()
  .transform((value) => Number.isFinite(value) ? Math.min(200, Math.max(-200, value)) : -200);

export const mixAnalysisSnapshotSchema = z.strictObject({
  schema: z.literal("rma.mix-analysis/v1"),
  projectId: z.string().min(1),
  projectChangeCount: z.number().int().nonnegative(),
  analyzedAt: z.string().datetime(),
  tracks: z.array(z.strictObject({
    trackGuid: z.string().min(1),
    name: z.string().min(1),
    index: z.number().int().nonnegative(),
    mediaItemCount: z.number().int().nonnegative(),
    mainSend: z.boolean(),
    fx: z.array(z.strictObject({
      guid: z.string().min(1),
      name: z.string().min(1),
      enabled: z.boolean(),
      offline: z.boolean(),
    })),
    sends: z.array(z.strictObject({
      destination_guid: z.string().min(1),
      destination_name: z.string().min(1),
      volume: z.number().finite().nonnegative(),
    })),
    hasSignal: z.boolean(),
    peakDb: meterValue,
    rmsMomentaryDb: meterValue,
    rmsIntegratedDb: meterValue,
    lufsMomentary: meterValue,
    lufsShortTerm: meterValue,
    lufsIntegrated: meterValue,
    loudnessRangeDb: z.number().finite().min(0).max(200),
  })).min(1),
});

export type MixAnalysisSnapshot = z.infer<typeof mixAnalysisSnapshotSchema>;

export interface MixAnalysisRequest {
  readonly sessionId: string;
  readonly iteration: number;
  readonly signal: AbortSignal;
}

export interface MixAnalyzer {
  capture(request: MixAnalysisRequest): Promise<MixAnalysisSnapshot>;
}

const projectIdentitySchema = z.object({ project_id: z.string().min(1) });

export interface ReaperMixAnalyzerOptions {
  readonly requester: BridgeRequester;
  readonly audioWorkRoot: string;
  readonly commandTimeoutMs?: number;
  readonly renderTimeoutMs?: number;
}

export class ReaperMixAnalyzer implements MixAnalyzer {
  public constructor(private readonly options: ReaperMixAnalyzerOptions) {}

  public async capture(request: MixAnalysisRequest): Promise<MixAnalysisSnapshot> {
    request.signal.throwIfAborted();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.sessionId)) {
      throw new TypeError("session id must be a filename-safe identifier");
    }
    if (!Number.isInteger(request.iteration) || request.iteration < 1) {
      throw new TypeError("iteration must be a positive integer");
    }
    const snapshotReceipt = await this.options.requester.request({
      sessionId: request.sessionId,
      operation: "project.snapshot",
      timeoutMs: this.options.commandTimeoutMs ?? 30_000,
      payload: {},
    });
    const project = projectIdentitySchema.parse(requireSuccessfulBridgeResult(snapshotReceipt, "project.snapshot"));
    const outputPath = join(
      this.options.audioWorkRoot,
      request.sessionId,
      "analysis",
      `iteration-${String(request.iteration).padStart(4, "0")}-${randomUUID()}`,
      "baseline.wav",
    );
    await mkdir(dirname(outputPath), { recursive: true });
    try {
      const receipt = await this.options.requester.request({
        sessionId: request.sessionId,
        operation: "analysis.capture",
        expectedProjectId: project.project_id,
        timeoutMs: this.options.renderTimeoutMs ?? 300_000,
        payload: {
          outputPath,
          sampleRate: 48_000,
          channels: 2,
          format: "wav",
          tailSeconds: 0,
        },
      });
      const analysis = mixAnalysisSnapshotSchema.parse(requireSuccessfulBridgeResult(receipt, "analysis.capture"));
      if (analysis.projectId !== project.project_id) {
        throw new Error("REAPER analysis changed project identity");
      }
      const baseline = await stat(outputPath);
      if (!baseline.isFile() || baseline.size === 0) {
        throw new Error("REAPER analysis baseline render is empty");
      }
      if (!analysis.tracks.some((track) => track.hasSignal)) {
        throw new Error("RMA_ANALYSIS_REQUIRED: baseline render contains no track signal");
      }
      request.signal.throwIfAborted();
      return analysis;
    } finally {
      await unlink(outputPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
