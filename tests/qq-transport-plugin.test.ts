import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";

import type { CommunicationModule } from "../src/contracts/communication.js";
import { CommunicationError } from "../src/communication/napcat-module.js";
import {
  createQqTransportPlugin,
  assertNoLegacyQqJournals,
  type ManagedCommunicationModule,
  type QqTransportPluginConfig,
} from "../src/plugins/qq-transport-plugin.js";

test("QQ transport startup fails closed when a legacy group journal still has evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-legacy-qq-journal-"));
  const directory = join(root, "communication", "qq");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "42-314.jsonl"), '{"kind":"delivery.attempting"}\n');

  await assert.rejects(
    assertNoLegacyQqJournals(root, "42", ["314"]),
    /legacy QQ journal requires operator migration/u,
  );
  await assert.doesNotReject(assertNoLegacyQqJournals(root, "42", ["999"]));
});

const config: QqTransportPluginConfig = {
  configPath: "/tmp/local.toml",
  napCatUrl: "http://127.0.0.1:3000",
  outboundStagingRoot: "/tmp/qq-outbound",
  tokenEnv: "NAPCAT_ONEBOT_TOKEN",
  accountId: "42",
  groupId: "314",
};

test("QQ transport plugin provides CommunicationModule for exactly its Cordis lifetime", async () => {
  const context = new Context();
  let starts = 0;
  let closes = 0;
  const communication: ManagedCommunicationModule = {
    subscribe: () => () => undefined,
    deliver: async () => { throw new Error("not used"); },
    status: async () => ({
      schema: "rma.communication-status/v1",
      state: "ready",
      channel: { kind: "qq", accountId: "42", conversationId: "314" },
      endpoint: "http://127.0.0.1:32180/onebot/events",
    }),
    start: async () => { starts += 1; },
    close: async () => { closes += 1; },
  };
  const plugin = createQqTransportPlugin({
    createModule: async () => communication,
  });

  const fiber = context.plugin(plugin, config);
  await fiber;

  assert.equal(starts, 1);
  assert.equal(context.get("communication"), communication as CommunicationModule);

  await fiber.dispose();

  assert.equal(closes, 1);
  assert.equal(context.get("communication"), undefined);
});

test("QQ transport plugin stays mounted and reconnects after NapCat is temporarily unavailable", async () => {
  const context = new Context();
  let starts = 0;
  let closes = 0;
  let releaseRetry: (() => void) | undefined;
  const retryAllowed = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  let markReconnected: (() => void) | undefined;
  const reconnected = new Promise<void>((resolve) => {
    markReconnected = resolve;
  });
  const communication: ManagedCommunicationModule = {
    subscribe: () => () => undefined,
    deliver: async () => { throw new Error("not used"); },
    status: async () => ({
      schema: "rma.communication-status/v1",
      state: starts > 1 ? "ready" : "failed",
      channel: { kind: "qq", accountId: "42", conversationId: "314" },
    }),
    start: async () => {
      starts += 1;
      if (starts === 1) {
        throw new CommunicationError("RMA_COMM_UNAVAILABLE", "NapCat is offline");
      }
      markReconnected?.();
    },
    close: async () => { closes += 1; },
  };
  const plugin = createQqTransportPlugin({
    createModule: async () => communication,
    waitForRetry: async () => retryAllowed,
  });

  const fiber = context.plugin(plugin, config);
  await fiber;

  assert.equal(starts, 1);
  assert.equal(context.get("communication"), communication as CommunicationModule);

  releaseRetry?.();
  await reconnected;
  assert.equal(starts, 2);

  await fiber.dispose();
  assert.equal(closes, 1);
});

test("QQ transport plugin disposal aborts an active reconnect attempt", async () => {
  const context = new Context();
  let starts = 0;
  let closes = 0;
  let markReconnectStarted: (() => void) | undefined;
  const reconnectStarted = new Promise<void>((resolve) => {
    markReconnectStarted = resolve;
  });
  const communication: ManagedCommunicationModule = {
    subscribe: () => () => undefined,
    deliver: async () => { throw new Error("not used"); },
    status: async () => ({
      schema: "rma.communication-status/v1",
      state: "failed",
      channel: { kind: "qq", accountId: "42", conversationId: "314" },
    }),
    start: async (signal) => {
      starts += 1;
      if (starts === 1) {
        throw new CommunicationError("RMA_COMM_UNAVAILABLE", "NapCat is offline");
      }
      markReconnectStarted?.();
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new CommunicationError("RMA_COMM_UNAVAILABLE", "reconnect aborted"));
        }, { once: true });
      });
    },
    close: async () => { closes += 1; },
  };
  const plugin = createQqTransportPlugin({
    createModule: async () => communication,
    waitForRetry: async () => undefined,
  });
  const fiber = context.plugin(plugin, config);
  await fiber;
  await reconnectStarted;

  await fiber.dispose();

  assert.equal(starts, 2);
  assert.equal(closes, 1);
});

test("QQ transport plugin fails closed on an account scope mismatch", async () => {
  const context = new Context();
  let closes = 0;
  const communication: ManagedCommunicationModule = {
    subscribe: () => () => undefined,
    deliver: async () => { throw new Error("not used"); },
    status: async () => ({
      schema: "rma.communication-status/v1",
      state: "failed",
      channel: { kind: "qq", accountId: "42", conversationId: "314" },
    }),
    start: async () => {
      throw new CommunicationError("RMA_COMM_SCOPE_MISMATCH", "wrong QQ account");
    },
    close: async () => { closes += 1; },
  };
  const plugin = createQqTransportPlugin({ createModule: async () => communication });

  const fiber = context.plugin(plugin, config);
  await assert.rejects(fiber.await(), /wrong QQ account/u);

  assert.equal(closes, 1);
  assert.equal(context.get("communication"), undefined);
  await fiber.dispose();
});

test("QQ transport plugin closes a module whose startup fails", async () => {
  const context = new Context();
  let closes = 0;
  const communication: ManagedCommunicationModule = {
    subscribe: () => () => undefined,
    deliver: async () => { throw new Error("not used"); },
    status: async () => ({
      schema: "rma.communication-status/v1",
      state: "failed",
      channel: { kind: "qq", accountId: "42", conversationId: "314" },
    }),
    start: async () => { throw new Error("listen failed"); },
    close: async () => { closes += 1; },
  };
  const plugin = createQqTransportPlugin({
    createModule: async () => communication,
  });

  const fiber = context.plugin(plugin, config);
  await assert.rejects(fiber.await(), /listen failed/u);

  assert.equal(closes, 1);
  assert.equal(context.get("communication"), undefined);
  await fiber.dispose();
});

test("QQ transport plugin validates account and token configuration before creating a module", async () => {
  const context = new Context();
  let creates = 0;
  const plugin = createQqTransportPlugin({
    createModule: async () => {
      creates += 1;
      throw new Error("must not create");
    },
  });

  const fiber = context.plugin(plugin, {
    ...config,
    accountId: "../escape",
    tokenEnv: "lowercase-token",
  });

  await assert.rejects(fiber.await(), /invalid config/u);
  assert.equal(creates, 0);
  await fiber.dispose();
});
