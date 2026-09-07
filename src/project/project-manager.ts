import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { requireSuccessfulBridgeResult, type JsonValue } from "../bridge/protocol.js";
import type { LocalArtifactStore } from "../communication/artifact-store.js";
import {
  type MaterialLibrary,
  type MaterialLibraryScope,
} from "../communication/material-catalog.js";
import type { MutationQueue } from "../host/mutation-queue.js";
import type { BridgeRequester } from "../mixing/reaper-mix-engine.js";

const projectNameSchema = z.string().trim().min(1).max(128).refine((value) =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  }), "project name must not contain control characters");

const trackNameSchema = projectNameSchema;

const rebuildReceiptSchema = z.strictObject({
  schema: z.literal("rma.project-rebuild-receipt/v1"),
  previousProjectId: z.string().min(1),
  previousProjectDiscarded: z.boolean(),
  project: z.record(z.string(), z.unknown()),
  placements: z.array(z.strictObject({
    artifactId: z.string().min(1),
    trackGuid: z.string().min(1),
    trackName: z.string().min(1),
    durationSeconds: z.number().positive(),
    alreadyPlaced: z.literal(false),
  })).min(1),
});

export interface ProjectMaterialPlacement {
  readonly artifactId: string;
  readonly trackName: string;
}

export interface ProjectRebuildRequest {
  readonly projectName: string;
  readonly materials: readonly ProjectMaterialPlacement[];
  readonly discardCurrent: boolean;
  readonly materialScope?: MaterialLibraryScope;
  readonly signal: AbortSignal;
}

export type ProjectRebuildReceipt = z.infer<typeof rebuildReceiptSchema>;

export interface ProjectManager {
  rebuild(request: ProjectRebuildRequest): Promise<ProjectRebuildReceipt>;
}

export interface ReaperProjectManagerOptions {
  readonly requester: BridgeRequester;
  readonly mutationQueue: MutationQueue;
  readonly materialLibrary: MaterialLibrary;
  readonly artifactStore: LocalArtifactStore;
  readonly audioWorkRoot: string;
  readonly commandTimeoutMs: number;
}

function safeProjectFileStem(projectName: string): string {
  const stem = projectName.normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return stem || "project";
}

function canonicalArtifactId(value: string): string {
  return /^[0-9a-f]{64}$/u.test(value) ? `artifact:${value}` : value;
}

export class ReaperProjectManager implements ProjectManager {
  public constructor(private readonly options: ReaperProjectManagerOptions) {}

  public rebuild(request: ProjectRebuildRequest): Promise<ProjectRebuildReceipt> {
    return this.options.mutationQueue.run(() => this.#rebuild(request));
  }

  async #rebuild(request: ProjectRebuildRequest): Promise<ProjectRebuildReceipt> {
    request.signal.throwIfAborted();
    const projectName = projectNameSchema.parse(request.projectName);
    const materials = z.array(z.strictObject({
      artifactId: z.string().min(1),
      trackName: trackNameSchema,
    })).min(1).max(64).parse(request.materials);
    const artifactIds = new Set<string>();
    const trackNames = new Set<string>();
    const files = await Promise.all(materials.map(async (placement) => {
      const artifactId = canonicalArtifactId(placement.artifactId);
      if (artifactIds.has(artifactId)) throw new Error(`material is assigned more than once: ${artifactId}`);
      artifactIds.add(artifactId);
      const trackIdentity = placement.trackName.normalize("NFC").toLocaleLowerCase("en-US");
      if (trackNames.has(trackIdentity)) {
        throw new Error(`project materials require distinct track names: ${placement.trackName}`);
      }
      trackNames.add(trackIdentity);
      const entry = await this.options.materialLibrary.find(artifactId, request.materialScope);
      if (!entry) throw new Error(`material ${artifactId} is not available in this material library scope`);
      if (entry.artifact.kind !== "audio") throw new Error(`material ${artifactId} is not audio`);
      const resolved = await this.options.artifactStore.resolve(entry.artifact, request.signal);
      return {
        artifactId,
        path: resolved.filePath,
        trackName: placement.trackName,
      };
    }));
    const workspaceId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const projectDirectory = join(this.options.audioWorkRoot, "projects", workspaceId);
    await mkdir(projectDirectory, { recursive: true });
    const projectPath = join(projectDirectory, `${safeProjectFileStem(projectName)}.rpp`);
    const receipt = await this.options.requester.request({
      sessionId: `project-rebuild-${randomUUID()}`,
      operation: "project.rebuild",
      timeoutMs: this.options.commandTimeoutMs,
      payload: {
        schema: "rma.project-rebuild/v1",
        projectName,
        projectPath,
        discardCurrent: request.discardCurrent,
        files,
      },
    });
    return rebuildReceiptSchema.parse(
      requireSuccessfulBridgeResult(receipt, "project.rebuild") as JsonValue,
    );
  }
}
