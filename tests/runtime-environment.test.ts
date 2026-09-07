import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadRuntimeEnvironment, parseRuntimeEnvironment } from "../src/runtime/environment.js";

test("runtime environment parser accepts shell-style assignments without evaluating code", () => {
  assert.deepEqual(parseRuntimeEnvironment([
    "# generated locally",
    "export RMA_QQ_ACCOUNT_ID=42",
    'RMA_QQ_GROUP_ID="314"',
    "RMA_QQ_PRIVATE_USER_IDS='7,8'",
    "",
  ].join("\n")), {
    RMA_QQ_ACCOUNT_ID: "42",
    RMA_QQ_GROUP_ID: "314",
    RMA_QQ_PRIVATE_USER_IDS: "7,8",
  });
  assert.throws(() => parseRuntimeEnvironment("X=$(touch /tmp/never)"), /unsupported value/u);
});

test("runtime environment file never overrides an already supplied process value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-env-"));
  const path = join(directory, "runtime.env");
  await writeFile(path, "RMA_TEST_EXISTING=file\nRMA_TEST_NEW=loaded\n", "utf8");
  await chmod(path, 0o600);
  process.env.RMA_TEST_EXISTING = "parent";
  delete process.env.RMA_TEST_NEW;

  const loaded = await loadRuntimeEnvironment(path);

  assert.deepEqual(loaded, ["RMA_TEST_NEW"]);
  assert.equal(process.env.RMA_TEST_EXISTING, "parent");
  assert.equal(process.env.RMA_TEST_NEW, "loaded");
  delete process.env.RMA_TEST_EXISTING;
  delete process.env.RMA_TEST_NEW;
});

test("runtime environment loader rejects relative or group-readable secret files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-env-permissions-"));
  const path = join(directory, "runtime.env");
  await writeFile(path, "RMA_TEST=value\n", { mode: 0o640 });
  await assert.rejects(loadRuntimeEnvironment("runtime.env"), /must be absolute/u);
  await assert.rejects(loadRuntimeEnvironment(path), /permissions must be 0600/u);
});
