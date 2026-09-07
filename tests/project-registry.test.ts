import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonProjectRegistry } from "../src/mixing/project-registry.js";

test("JsonProjectRegistry resolves names and atomically advances its ledger projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-project-registry-"));
  const path = join(root, "projects", "registry.json");
  const registry = new JsonProjectRegistry(path);
  assert.deepEqual(await registry.list(), []);

  await mkdir(join(root, "projects"), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    schema: "rma.project-registry/v1",
    projects: [{
      name: "everytime",
      sessionId: "project-session",
      projectPath: "/projects/everytime.rpp",
      currentVersion: 89,
      registeredAt: "2026-08-25T00:00:00.000Z",
    }],
  })}\n`);

  assert.equal((await registry.find(" EveryTime "))?.sessionId, "project-session");
  await Promise.all([
    registry.advanceVersion("project-session", 90),
    registry.advanceVersion("project-session", 91),
  ]);
  assert.equal((await registry.find("everytime"))?.currentVersion, 91);
  assert.equal(JSON.parse(await readFile(path, "utf8")).projects[0].currentVersion, 91);
  await registry.advanceVersion("project-session", 90);
  assert.equal((await registry.find("everytime"))?.currentVersion, 91);
});

test("JsonProjectRegistry rejects malformed durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-project-registry-invalid-"));
  const path = join(root, "registry.json");
  await writeFile(path, JSON.stringify({ schema: "rma.project-registry/v1", projects: [{ name: "broken" }] }));
  await assert.rejects(new JsonProjectRegistry(path).list());
});
