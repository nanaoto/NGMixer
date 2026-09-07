import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { agentEvents, type Agent, type RequestErrorAction } from "@deepseek-ai/dsh-agent";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";

import {
  apply,
  type ModelFailoverPluginConfig,
} from "../src/dsh/model-failover-plugin.js";

const pool: ModelFailoverPluginConfig = {
  pools: [{
    routes: [
      { provider: "primary", model: "same-model" },
      { provider: "backup-a", model: "same-model" },
      { provider: "backup-b", model: "same-model" },
    ],
  }],
};

const agent = { id: "agent-1" } as unknown as Agent;
const signal = new AbortController().signal;

async function request(
  context: Context,
  turn: number,
  step: number,
): Promise<LlmCallConfig> {
  return await agentEvents(context, agent).waterfall("agent/request", {
    turn,
    step,
    signal,
  }, async () => ({ provider: "primary", model: "same-model" }));
}

async function fail(
  context: Context,
  turn: number,
  step: number,
  provider: string,
  failure: { readonly code: string; readonly message: string; readonly status?: number },
  delegated: () => void,
): Promise<RequestErrorAction> {
  return await agentEvents(context, agent).waterfall("agent/request-error", {
    turn,
    step,
    provider,
    failure,
    retryPolicy: undefined,
    signal,
  }, async () => {
    delegated();
    return undefined;
  });
}

test("model failover switches 403 and transport failures across one ordered route pool", async () => {
  const context = new Context();
  const fiber = context.plugin({ apply, name: "model-failover-test" }, pool);
  await fiber;
  let delegated = 0;

  assert.deepEqual(await request(context, 1, 1), { provider: "primary", model: "same-model" });
  assert.deepEqual(
    await fail(context, 1, 1, "primary", { code: "AUTH", message: "forbidden", status: 403 }, () => {
      delegated += 1;
    }),
    { kind: "retry" },
  );
  assert.deepEqual(await request(context, 1, 1), { provider: "backup-a", model: "same-model" });

  assert.deepEqual(
    await fail(context, 1, 1, "backup-a", { code: "TRANSPORT", message: "connect failed" }, () => {
      delegated += 1;
    }),
    { kind: "retry" },
  );
  assert.deepEqual(await request(context, 1, 1), { provider: "backup-b", model: "same-model" });

  assert.equal(
    await fail(context, 1, 1, "backup-b", { code: "TIMEOUT", message: "connect timeout" }, () => {
      delegated += 1;
    }),
    undefined,
  );
  assert.equal(delegated, 0);
  assert.deepEqual(await request(context, 1, 2), { provider: "primary", model: "same-model" });

  await fiber.dispose();
});

test("model failover delegates failures that do not identify endpoint unavailability", async () => {
  const context = new Context();
  const fiber = context.plugin({ apply, name: "model-failover-test" }, pool);
  await fiber;
  let delegated = 0;

  await request(context, 2, 1);
  assert.equal(
    await fail(context, 2, 1, "primary", { code: "BAD_REQUEST", message: "invalid request" }, () => {
      delegated += 1;
    }),
    undefined,
  );
  assert.equal(delegated, 1);

  await fiber.dispose();
});
