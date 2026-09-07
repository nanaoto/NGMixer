import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBridgeStatuses } from "../src/bridge/heartbeat.js";

test("reads and validates bridge heartbeat files", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-heartbeat-"));
  const bridgeRoot = join(runtimeRoot, "bridge", "bridge-a");
  await mkdir(bridgeRoot, { recursive: true });
  await writeFile(
    join(bridgeRoot, "heartbeat.json"),
    JSON.stringify({
      schema: "rma.bridge-heartbeat/v1",
      bridge_instance_id: "bridge-a",
      protocol_version: 1,
      observed_at: "2026-08-19T01:00:00.000Z",
      reaper_version: "7.50/macOS-arm64",
      project_id: "project-1",
      project_change_count: 4,
      state: "idle",
      active_command_id: null,
    }),
  );

  const statuses = await readBridgeStatuses(runtimeRoot);

  assert.equal(statuses.length, 1);
  assert.equal(statuses[0]?.bridge_instance_id, "bridge-a");
  assert.equal(statuses[0]?.project_change_count, 4);
});

test("rejects a malformed heartbeat rather than presenting it as healthy", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-heartbeat-"));
  const bridgeRoot = join(runtimeRoot, "bridge", "bridge-a");
  await mkdir(bridgeRoot, { recursive: true });
  await writeFile(join(bridgeRoot, "heartbeat.json"), '{"schema":"wrong"}');

  await assert.rejects(readBridgeStatuses(runtimeRoot), /invalid heartbeat bridge-a/);
});

test("an absent bridge directory produces an empty status list", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "rma-heartbeat-"));
  assert.deepEqual(await readBridgeStatuses(runtimeRoot), []);
});
