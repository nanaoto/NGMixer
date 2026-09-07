import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonlCommunicationJournal } from "../src/communication/napcat-module.js";
import { runCli } from "../src/cli.js";
import { writeConfig } from "./helpers.js";

test("doctor CLI prints PASS lines and returns zero for an injected supported runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-cli-"));
  const configPath = await writeConfig(directory);
  const output: string[] = [];

  const exitCode = await runCli(
    ["node", "mixing-agent", "doctor", "--config", configPath, "--keyless"],
    { nodeVersion: "v22.19.0", write: (line) => output.push(line) },
  );

  assert.equal(exitCode, 0);
  assert.ok(output.some((line) => line.startsWith("PASS config")));
  assert.ok(output.some((line) => line.startsWith("PASS Node")));
});

test("doctor CLI returns one for the current unsupported major without printing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-cli-"));
  const configPath = await writeConfig(directory, { apiKeyEnv: "RMA_SECRET" });
  process.env.RMA_SECRET = "do-not-print";
  const output: string[] = [];

  const exitCode = await runCli(
    ["node", "mixing-agent", "doctor", "--config", configPath],
    { nodeVersion: "v25.8.0", write: (line) => output.push(line) },
  );

  assert.equal(exitCode, 1);
  assert.ok(output.some((line) => line.includes("FAIL Node v25.8.0")));
  assert.equal(output.join("\n").includes("do-not-print"), false);
  delete process.env.RMA_SECRET;
});

test("NapCat doctor verifies the configured personal QQ account and target group", async () => {
  process.env.NAPCAT_TEST_TOKEN = "secret";
  const output: string[] = [];
  const exitCode = await runCli([
    "node",
    "mixing-agent",
    "qq",
    "napcat-doctor",
    "--napcat-url",
    "http://[::1]:3000",
    "--napcat-token-env",
    "NAPCAT_TEST_TOKEN",
    "--qq-account-id",
    "42",
    "--qq-group-id",
    "456",
  ], {
    fetcher: async (input) => {
      const action = String(input).split("/").at(-1);
      const data = action === "get_login_info"
        ? { user_id: "42", nickname: "Mix Account" }
        : action === "get_status"
          ? { online: true, good: true }
          : { group_id: "456", group_name: "Mix Feedback" };
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data }), { status: 200 });
    },
    write: (line) => output.push(line),
  });

  delete process.env.NAPCAT_TEST_TOKEN;
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.join("\n")) as unknown, {
    status: "ready",
    accountId: "42",
    nickname: "Mix Account",
    groupId: "456",
    groupName: "Mix Feedback",
  });
});

test("macOS bootstrap CLI passes the explicit QQ communication scopes without leaking tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-cli-bootstrap-"));
  const configPath = await writeConfig(directory);
  const output: string[] = [];
  let captured: {
    accountId?: string;
    groupId?: string;
    privateUserIds?: readonly string[];
    providerApiKeyEnvs?: readonly string[];
  } = {};
  const exitCode = await runCli([
    "node", "mixing-agent", "qq", "bootstrap-macos",
    "--config", configPath,
    "--qq-account-id", "123456",
    "--qq-group-id", "234567",
    "--private-user-id", "345678", "456789",
    "--no-reload-launch-agent",
  ], {
    bootstrapNapCat: async (options) => {
      captured = options;
      return {
        runtimeEnvironmentPath: "/private/runtime.env",
        oneBotConfigPath: "/private/onebot.json",
        launchAgentPath: "/private/agent.plist",
        backups: [],
      };
    },
    write: (line) => output.push(line),
  });

  assert.equal(exitCode, 0);
  assert.equal(captured.accountId, "123456");
  assert.equal(captured.groupId, "234567");
  assert.deepEqual(captured.privateUserIds, ["345678", "456789"]);
  assert.deepEqual(captured.providerApiKeyEnvs, ["RMA_TEST_KEY"]);
  assert.equal(output.join("\n").includes("token"), false);
});

test("delivery reconciliation updates the authoritative QQ communication journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-cli-reconcile-"));
  const runtimeRoot = join(directory, "runtime");
  const configPath = await writeConfig(directory, { runtimeRoot });
  const journal = new JsonlCommunicationJournal(join(runtimeRoot, "communication", "qq", "42.jsonl"));
  await journal.recordAttempting({
    schema: "rma.outbound-message/v1",
    deliveryId: "delivery-cli-reconcile",
    target: { kind: "qq", accountId: "42", conversation: { kind: "group", id: "314" } },
    text: "第 1 版",
    artifacts: [],
  });
  await journal.recordSettled({
    schema: "rma.delivery-receipt/v1",
    deliveryId: "delivery-cli-reconcile",
    status: "uncertain",
    occurredAt: "2026-08-21T03:00:00.000Z",
    errorCode: "RMA_DELIVERY_UNCERTAIN",
  });
  const output: string[] = [];

  const exitCode = await runCli([
    "node", "mixing-agent", "qq", "reconcile-delivery",
    "--config", configPath,
    "--qq-account-id", "42",
    "--qq-group-id", "314",
    "--delivery-id", "delivery-cli-reconcile",
    "--outcome", "delivered",
    "--message-id", "qq-confirmed-cli",
  ], { write: (line) => output.push(line) });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(output.join("\n")).receipt.platformMessageId, "qq-confirmed-cli");
  assert.equal((await journal.findDelivery("delivery-cli-reconcile") as { status?: string }).status, "delivered");
});
