import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { LlmCallConfig, LlmFailure } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

import type { LlmModelRoute } from "../config.js";

export const name = "model-failover";

const routeSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const Config = z.strictObject({
  pools: z.array(z.strictObject({
    routes: z.array(routeSchema).min(2),
  })).default([]),
});

export type ModelFailoverPluginConfig = z.infer<typeof Config>;

interface AttemptState {
  readonly turn: number;
  readonly step: number;
  readonly routes: readonly LlmModelRoute[];
  index: number;
}

const endpointFailureCodes = new Set([
  "AUTH",
  "INVALID_CREDENTIAL",
  "MISSING_CREDENTIAL",
  "QUOTA",
  "TIMEOUT",
  "TRANSPORT",
]);

export function isEndpointUnavailableFailure(failure: LlmFailure): boolean {
  return failure.status === 403 || endpointFailureCodes.has(failure.code);
}

function sameRoute(left: LlmModelRoute, right: LlmModelRoute): boolean {
  return left.provider === right.provider && left.model === right.model;
}

function routeRequest(request: LlmCallConfig, route: LlmModelRoute): LlmCallConfig {
  return { ...request, provider: route.provider, model: route.model };
}

export function apply(context: Context, config: ModelFailoverPluginConfig): () => void {
  const states = new WeakMap<Agent, AttemptState>();
  const pools = config.pools.map((pool) => pool.routes);
  const disposeRequest = context.on("agent/request", async (payload, next) => {
    const request = await next();
    const existing = states.get(payload.agent);
    if (existing?.turn === payload.turn && existing.step === payload.step) {
      return routeRequest(request, existing.routes[existing.index]!);
    }
    const routes = pools.find((candidate) => sameRoute(candidate[0]!, request));
    if (!routes) {
      states.delete(payload.agent);
      return request;
    }
    states.set(payload.agent, { turn: payload.turn, step: payload.step, routes, index: 0 });
    return routeRequest(request, routes[0]!);
  }, { prepend: true });
  const disposeFailure = context.on("agent/request-error", async (payload, next) => {
    const state = states.get(payload.agent);
    const route = state?.routes[state.index];
    if (!state
      || state.turn !== payload.turn
      || state.step !== payload.step
      || route?.provider !== payload.provider
      || !isEndpointUnavailableFailure(payload.failure)) return await next();
    if (state.index + 1 >= state.routes.length) return undefined;
    state.index += 1;
    return { kind: "retry" };
  }, { prepend: true });
  return () => {
    disposeFailure();
    disposeRequest();
  };
}
