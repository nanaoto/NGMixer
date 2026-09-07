import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

import type { LocalArtifactStore } from "../src/communication/artifact-store.js";
import type { MaterialLibrary } from "../src/communication/material-catalog.js";
import { createMaterialLibraryTool, createProjectRebuildTool } from "../src/dsh/project-tools.js";
import { SerialMutationQueue } from "../src/host/mutation-queue.js";
import type { BridgeRequest, BridgeRequester } from "../src/mixing/reaper-mix-engine.js";
import { ReaperProjectManager } from "../src/project/project-manager.js";

const artifact = {
  schema: "rma.artifact-ref/v1" as const,
  artifactId: `artifact:${"a".repeat(64)}`,
  kind: "audio" as const,
  availability: "available" as const,
  fileName: "旧主音.wav",
  bytes: 123,
  sha256: "a".repeat(64),
};

const entry = { accountId: "3944407153", ownerId: "350217866", messageId: "100", artifact };

function materialLibrary(): MaterialLibrary {
  return {
    list: async (accountId, ownerId) => accountId === entry.accountId && ownerId === entry.ownerId
      ? [artifact]
      : [],
    inventory: async (scope = {}) => scope.accountId !== undefined && scope.accountId !== entry.accountId
      || scope.ownerId !== undefined && scope.ownerId !== entry.ownerId ? [] : [entry],
    find: async (artifactId, scope = {}) => {
      const visible = scope.accountId !== undefined && scope.accountId !== entry.accountId
        || scope.ownerId !== undefined && scope.ownerId !== entry.ownerId ? false : true;
      return visible && (artifactId === artifact.artifactId || artifactId === artifact.sha256) ? entry : undefined;
    },
  };
}

test("Project Manager resolves durable material identities and submits one staged rebuild operation", async () => {
  const audioWorkRoot = await mkdtemp(join(tmpdir(), "rma-project-manager-"));
  let submitted: BridgeRequest | undefined;
  const requester: BridgeRequester = {
    request: async (request) => {
      submitted = request;
      return {
        schema: "rma.bridge-receipt/v1",
        protocol_version: 1,
        command_id: "00000000-0000-4000-8000-000000000000",
        status: "succeeded",
        started_at: "2026-08-21T00:00:00Z",
        finished_at: "2026-08-21T00:00:01Z",
        artifacts: [],
        warnings: [],
        error: null,
        result: {
          schema: "rma.project-rebuild-receipt/v1",
          previousProjectId: "unsaved:main",
          previousProjectDiscarded: true,
          project: { project_id: "/audio/projects/new/song.rpp", track_count: 1 },
          placements: [{
            artifactId: artifact.artifactId,
            trackGuid: "{TRACK-1}",
            trackName: "旧主音",
            durationSeconds: 30,
            alreadyPlaced: false,
          }],
        },
      };
    },
  };
  const manager = new ReaperProjectManager({
    requester,
    mutationQueue: new SerialMutationQueue(),
    materialLibrary: materialLibrary(),
    artifactStore: {
      resolve: async () => ({ filePath: `/audio/qq-imports/${artifact.sha256}/旧主音.wav`, fileName: "旧主音.wav" }),
    } as unknown as LocalArtifactStore,
    audioWorkRoot,
    commandTimeoutMs: 30_000,
  });

  const result = await manager.rebuild({
    projectName: "干净工程",
    materials: [{ artifactId: artifact.sha256, trackName: "旧主音" }],
    discardCurrent: true,
    materialScope: { accountId: entry.accountId, ownerId: entry.ownerId },
    signal: new AbortController().signal,
  });

  assert.ok(submitted);
  assert.equal(submitted.operation, "project.rebuild");
  assert.deepEqual((submitted.payload as { files: unknown }).files, [{
    artifactId: artifact.artifactId,
    path: `/audio/qq-imports/${artifact.sha256}/旧主音.wav`,
    trackName: "旧主音",
  }]);
  assert.match(
    (submitted.payload as { projectPath: string }).projectPath,
    new RegExp(`^${audioWorkRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/projects/.+/干净工程\\.rpp$`, "u"),
  );
  assert.equal(result.previousProjectDiscarded, true);
});

test("DSH material and rebuild tools keep a QQ sender inside its durable material scope", async () => {
  const library = materialLibrary();
  const scope = { accountId: entry.accountId, ownerId: entry.ownerId };
  const toolContext = {
    signal: new AbortController().signal,
    agent: { id: "qq-agent" },
  } as unknown as ToolRunContext;
  const list = createMaterialLibraryTool(library, () => scope);
  const calls: unknown[] = [];
  const rebuild = createProjectRebuildTool({
    rebuild: async (request) => {
      calls.push(request);
      return {
        schema: "rma.project-rebuild-receipt/v1",
        previousProjectId: "old",
        previousProjectDiscarded: false,
        project: { project_id: "new" },
        placements: [{
          artifactId: artifact.artifactId,
          trackGuid: "{T}",
          trackName: "主音",
          durationSeconds: 1,
          alreadyPlaced: false,
        }],
      };
    },
  }, () => scope);

  const inventory = await list.execute({}, toolContext) as { materials: Array<{ artifactId: string }> };
  await rebuild.execute({
    projectName: "新工程",
    materials: [{ artifactId: artifact.artifactId, trackName: "主音" }],
    discardCurrent: false,
  }, toolContext);

  assert.deepEqual(inventory.materials.map((item) => item.artifactId), [artifact.artifactId]);
  assert.deepEqual((calls[0] as { materialScope: unknown }).materialScope, scope);
});
