import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeSpool, BridgeTimeoutError } from "../src/bridge/spool.js";

test("rejects bridge instance ids that could escape the runtime root", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-spool-"));
  assert.throws(() => new BridgeSpool(runtimeRoot, "../../outside"), /bridge instance id/);
});

test("submits a complete command by atomic tmp-to-ready rename", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-spool-"));
  const spool = new BridgeSpool(runtimeRoot, "bridge-test", { pollIntervalMs: 5 });

  const command = await spool.submitCommand({
    sessionId: "session-test",
    operation: "bridge.health",
    timeoutMs: 500,
    payload: { probe: "ready" },
  });

  assert.match(command.command_id, /^[0-9a-f-]{36}$/);
  assert.equal(command.schema, "rma.bridge-command/v1");
  assert.equal(command.protocol_version, 1);
  assert.equal(command.bridge_instance_id, "bridge-test");
  assert.equal(
    command.payload_sha256,
    `sha256:${createHash("sha256").update('{"probe":"ready"}').digest("hex")}`,
  );
  assert.deepEqual(await readdir(join(runtimeRoot, "bridge/bridge-test/commands/tmp")), []);
  const readyPath = join(runtimeRoot, `bridge/bridge-test/commands/ready/${command.command_id}.json`);
  assert.deepEqual(JSON.parse(await readFile(readyPath, "utf8")), command);
});

test("waitForReceipt returns a validated receipt produced by a fake bridge", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-spool-"));
  const spool = new BridgeSpool(runtimeRoot, "bridge-test", { pollIntervalMs: 5 });
  const command = await spool.submitCommand({
    sessionId: "session-test",
    operation: "bridge.health",
    timeoutMs: 500,
    payload: {},
  });
  const receiptRoot = join(runtimeRoot, "bridge/bridge-test/receipts");

  const fakeBridge = (async () => {
    await mkdir(join(receiptRoot, "tmp"), { recursive: true });
    await mkdir(join(receiptRoot, "ready"), { recursive: true });
    const receipt = {
      schema: "rma.bridge-receipt/v1",
      protocol_version: 1,
      command_id: command.command_id,
      status: "succeeded",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      artifacts: [],
      warnings: [],
      error: null,
      result: { state: "idle" },
    };
    const temporary = join(receiptRoot, "tmp", `${command.command_id}.json`);
    await writeFile(temporary, JSON.stringify(receipt));
    await rename(temporary, join(receiptRoot, "ready", `${command.command_id}.json`));
  })();

  const receipt = await spool.waitForReceipt(command.command_id, 500);
  await fakeBridge;
  assert.equal(receipt.command_id, command.command_id);
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(receipt.result, { state: "idle" });
});

test("waitForReceipt times out without replaying or moving the command", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-spool-"));
  const spool = new BridgeSpool(runtimeRoot, "bridge-test", { pollIntervalMs: 5 });
  const command = await spool.submitCommand({
    sessionId: "session-test",
    operation: "bridge.health",
    timeoutMs: 500,
    payload: {},
  });

  await assert.rejects(spool.waitForReceipt(command.command_id, 20), BridgeTimeoutError);
  const files = await readdir(join(runtimeRoot, "bridge/bridge-test/commands/ready"));
  assert.deepEqual(files, [`${command.command_id}.json`]);
});

test("waitForReceipt stops promptly when its caller aborts", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-spool-"));
  const spool = new BridgeSpool(runtimeRoot, "bridge-test", { pollIntervalMs: 1_000 });
  const command = await spool.submitCommand({
    sessionId: "session-test",
    operation: "bridge.health",
    timeoutMs: 5_000,
    payload: {},
  });
  const controller = new AbortController();
  const pending = spool.waitForReceipt(command.command_id, 5_000, controller.signal);

  controller.abort();

  await assert.rejects(pending, { name: "AbortError" });
});

test("snapshot request carries optional project preconditions in its envelope", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-spool-"));
  const spool = new BridgeSpool(runtimeRoot, "bridge-test");

  const command = await spool.submitCommand({
    sessionId: "session-test",
    operation: "project.snapshot",
    timeoutMs: 1_000,
    expectedProjectId: "project-test",
    expectedSnapshotHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    payload: { includeFx: true },
  });

  assert.equal(command.operation, "project.snapshot");
  assert.equal(command.expected_project_id, "project-test");
  assert.equal(
    command.expected_snapshot_hash,
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.deepEqual(command.payload, { includeFx: true });
});
