import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlMaterialCatalog } from "../src/communication/material-catalog.js";

test("material catalog lets the same QQ user reuse a private upload from a group conversation after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-material-catalog-"));
  const path = join(root, "materials.jsonl");
  const catalog = new JsonlMaterialCatalog(path);
  const artifact = {
    schema: "rma.artifact-ref/v1" as const,
    artifactId: `artifact:${"b".repeat(64)}`,
    kind: "audio" as const,
    availability: "available" as const,
    fileName: "lead.wav",
    bytes: 123,
    sha256: "b".repeat(64),
  };

  await Promise.all([
    catalog.remember({ accountId: "42", ownerId: "7", messageId: "private-1", artifact }),
    catalog.remember({ accountId: "42", ownerId: "7", messageId: "private-1", artifact }),
  ]);

  assert.deepEqual(await new JsonlMaterialCatalog(path).list("42", "7"), [artifact]);
  assert.deepEqual(await new JsonlMaterialCatalog(path).list("42", "8"), []);
  assert.deepEqual(await new JsonlMaterialCatalog(path).inventory({ accountId: "42", ownerId: "7" }), [{
    accountId: "42",
    ownerId: "7",
    messageId: "private-1",
    artifact,
  }]);
  assert.equal(
    (await new JsonlMaterialCatalog(path).find(artifact.sha256, { accountId: "42", ownerId: "7" }))
      ?.artifact.artifactId,
    artifact.artifactId,
  );
});
