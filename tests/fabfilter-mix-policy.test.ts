import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeReceipt } from "../src/bridge/protocol.js";
import {
  FabFilterMixPolicy,
} from "../src/mixing/fabfilter-mix-policy.js";
import type { MixPlan } from "../src/mixing/intent-compiler.js";
import type { BridgeRequest, BridgeRequester } from "../src/mixing/reaper-mix-engine.js";

const plan: MixPlan = {
  schema: "rma.mix-plan/v2",
  sourceEventId: "qq-1",
  sourceText: "人声亮一点，压缩和齿音控制多一点",
  summary: "vocal polish",
  actions: [
    { type: "fx.parameter.delta", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, fx: "ReaEQ (Cockos)", parameter: "semantic:airGain", deltaNormalized: 0.04, reason: "air" },
    { type: "fx.parameter.delta", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, fx: "ReaComp (Cockos)", parameter: "semantic:compressorThreshold", deltaNormalized: -0.025, reason: "control" },
    { type: "fx.parameter.delta", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, fx: "ReaXcomp (Cockos)", parameter: "semantic:deesserThreshold", deltaNormalized: -0.02, reason: "de-ess" },
  ],
};

test("mix policy upgrades stock semantic actions only after live FabFilter probes prove the controls", async () => {
  const requests: BridgeRequest[] = [];
  const parameters: Record<string, Array<{
    name: string;
    ident: string;
    normalizedValue: number;
    formattedValue: string;
  }>> = {
    "Pro-Q 4 (FabFilter)": [
      parameter("Band 4 Used", "69:69", 1, "On"),
      parameter("Band 4 Enabled", "70:70", 1, "On"),
      parameter("Band 4 Frequency", "71:71", 0.8, "10.00 kHz"),
      parameter("Band 4 Gain", "72:72", 0.5, "0.00 dB"),
      parameter("Band 4 Shape", "74:74", 0.4, "High Shelf"),
    ],
    "Pro-C 2 (FabFilter)": [parameter("Threshold", "param.0", 0.5, "-18.0 dB")],
    "Pro-DS (FabFilter)": [parameter("Threshold", "param.0", 0.5, "-24.0 dB")],
  };
  const requester: BridgeRequester = {
    request: async (request) => {
      requests.push(request);
      if (request.operation === "project.snapshot") {
        return receipt({ tracks: [{
          guid: "{TRACK-1}",
          name: "LEAD VOCAL",
          fx: Object.keys(parameters).map((name, index) => ({
            guid: `{FAB-${index}}`, name: `VST3: ${name}`, enabled: true, offline: false,
          })),
        }] });
      }
      const plugin = (request.payload as { plugin: string }).plugin;
      return receipt({
        plugin,
        format: "VST3",
        parameters: parameters[plugin]!.map((parameterValue, index) => ({ index, ...parameterValue })),
      });
    },
  };
  const policy = new FabFilterMixPolicy({
    requester,
    commandTimeoutMs: 1234,
    installed: [
      installed("Pro-Q 4"),
      installed("Pro-C 2"),
      installed("Pro-DS"),
    ],
  });

  const resolved = await policy.resolve(plan);

  assert.deepEqual(resolved.actions.map((action) => action.type === "fx.parameter.delta" ? action.fx : ""), [
    "Pro-Q 4 (FabFilter)",
    "Pro-C 2 (FabFilter)",
    "Pro-DS (FabFilter)",
  ]);
  assert.deepEqual(resolved.actions.map((action) => action.type === "fx.parameter.delta"
    ? { fxFormat: action.fxFormat, fxGuid: action.fxGuid, parameterIdent: action.parameterIdent }
    : {}), [
    { fxFormat: "VST3", fxGuid: "{FAB-0}", parameterIdent: "72:72" },
    { fxFormat: "VST3", fxGuid: "{FAB-1}", parameterIdent: "param.0" },
    { fxFormat: "VST3", fxGuid: "{FAB-2}", parameterIdent: "param.0" },
  ]);
  assert.deepEqual(requests.map((request) => request.operation), ["project.snapshot", "fx.probe", "fx.probe", "fx.probe"]);
  assert.deepEqual(requests.slice(1).map((request) => request.payload), [
    { plugin: "Pro-Q 4 (FabFilter)", format: "VST3", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, fxGuid: "{FAB-0}" },
    { plugin: "Pro-C 2 (FabFilter)", format: "VST3", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, fxGuid: "{FAB-1}" },
    { plugin: "Pro-DS (FabFilter)", format: "VST3", track: { guid: "{TRACK-1}", name: "LEAD VOCAL" }, fxGuid: "{FAB-2}" },
  ]);
  assert.equal(requests.every((request) => request.timeoutMs === 1234), true);
});

test("mix policy keeps stock FX when a plug-in is absent or its live parameter surface is unproven", async () => {
  const policy = new FabFilterMixPolicy({
    requester: {
      request: async (request) => request.operation === "project.snapshot"
        ? receipt({ tracks: [{
            guid: "{TRACK-1}",
            name: "LEAD VOCAL",
            fx: [{ guid: "{FAB-Q}", name: "VST3: Pro-Q 4 (FabFilter)", enabled: true, offline: false }],
          }] })
        : receipt({
            plugin: (request.payload as { plugin: string }).plugin,
            format: "VST3",
            parameters: [
              { index: 0, ...parameter("Gain High Shelf 1", "param.0", 0.5, "0.0 dB") },
              { index: 1, ...parameter("Gain High Shelf 2", "param.1", 0.5, "0.0 dB") },
            ],
          }),
    },
    installed: [installed("Pro-Q 4")],
  });

  const resolved = await policy.resolve(plan);

  assert.deepEqual(resolved.actions, plan.actions);
});

test("mix policy refuses an ambiguous duplicate FabFilter instance instead of targeting the first one", async () => {
  let probed = false;
  const policy = new FabFilterMixPolicy({
    requester: {
      request: async (request) => {
        if (request.operation === "project.snapshot") {
          return receipt({ tracks: [{ guid: "{TRACK-1}", name: "LEAD VOCAL", fx: [
            { guid: "{FAB-Q-1}", name: "VST3: Pro-Q 4 (FabFilter)", enabled: true, offline: false },
            { guid: "{FAB-Q-2}", name: "VST3: Pro-Q 4 (FabFilter)", enabled: true, offline: false },
          ] }] });
        }
        probed = true;
        return receipt({ plugin: "Pro-Q 4 (FabFilter)", format: "VST3", parameters: [] });
      },
    },
    installed: [installed("Pro-Q 4")],
  });

  const resolved = await policy.resolve({ ...plan, actions: [plan.actions[0]!] });

  assert.deepEqual(resolved.actions, [plan.actions[0]]);
  assert.equal(probed, false);
});

function parameter(
  name: string,
  ident: string,
  normalizedValue: number,
  formattedValue: string,
) {
  return { name, ident, normalizedValue, formattedValue };
}

function installed(product: "Pro-Q 4" | "Pro-C 2" | "Pro-DS") {
  const installation = {
    format: "VST3" as const,
    reaperCacheKey: `FabFilter_${product.replaceAll(" ", "_")}.vst3`,
    reaperName: `${product} (FabFilter)`,
  };
  return {
    product,
    formats: ["VST3" as const],
    preferredReaperName: `${product} (FabFilter)`,
    installations: [installation],
    preferredInstallation: installation,
    automation: "profiled" as const,
  };
}

function receipt(result: unknown): BridgeReceipt {
  return {
    schema: "rma.bridge-receipt/v1",
    protocol_version: 1,
    command_id: "0198bfda-ef7d-75b2-84ae-b5b7d54c1800",
    status: "succeeded",
    started_at: "2026-08-20T12:00:00Z",
    finished_at: "2026-08-20T12:00:01Z",
    artifacts: [],
    warnings: [],
    error: null,
    result,
  };
}
