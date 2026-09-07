import { z } from "zod";

import type { InstalledFabFilterPlugin } from "../mcp/fabfilter-catalog.js";
import { fabFilterProbeResultSchema } from "../mcp/fabfilter-protocol.js";
import type { MixAction, MixPlan } from "./intent-compiler.js";
import type { BridgeRequester } from "./reaper-mix-engine.js";

const projectFxSchema = z.object({
  tracks: z.array(z.object({
    guid: z.string().min(1),
    name: z.string(),
    fx: z.array(z.object({
      name: z.string(),
      guid: z.string().min(1),
      enabled: z.boolean(),
      offline: z.boolean(),
    })),
  })),
});

interface SemanticPreference {
  readonly product: string;
  readonly fx: Extract<MixAction, { type: "fx.parameter.delta" }>["fx"];
  readonly select: (parameters: readonly ProbeParameter[]) => ProbeParameter | undefined;
}

type ProbeParameter = z.infer<typeof fabFilterProbeResultSchema>["parameters"][number];
type FxAction = Extract<MixAction, { type: "fx.parameter.delta" }>;
type ProjectFx = z.infer<typeof projectFxSchema>["tracks"][number]["fx"][number];

interface ProvenTarget {
  readonly fx: FxAction["fx"];
  readonly fxFormat: "VST3" | "CLAP";
  readonly fxGuid: string;
  readonly parameterIdent: string;
}

function normalizedParameterName(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
}

function supportedInstance(value: string): { format: "VST3" | "CLAP"; name: string } | undefined {
  const match = /^(VST3|CLAP):\s*(.+)$/u.exec(value);
  if (!match) return undefined;
  return { format: match[1] as "VST3" | "CLAP", name: match[2]! };
}

function uniqueParameter(
  parameters: readonly ProbeParameter[],
  predicate: (normalizedName: string) => boolean,
): ProbeParameter | undefined {
  const matches = parameters.filter((parameter) => {
    const normalized = normalizedParameterName(parameter.name);
    return parameter.ident.length > 0 && predicate(normalized);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function selectUnambiguousThreshold(parameters: readonly ProbeParameter[]): ProbeParameter | undefined {
  return uniqueParameter(parameters, (normalized) => {
    return normalized === "threshold" || normalized === "compressionthreshold";
  });
}

function formattedFrequencyHz(parameter: ProbeParameter | undefined): number | undefined {
  if (!parameter) return undefined;
  const match = /([0-9]+(?:[.,][0-9]+)?)\s*(k?hz)/iu.exec(parameter.formattedValue);
  if (!match) return undefined;
  const value = Number((match[1] ?? "").replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  return (match[2] ?? "").toLocaleLowerCase("en-US") === "khz" ? value * 1000 : value;
}

function selectAirGain(parameters: readonly ProbeParameter[]): ProbeParameter | undefined {
  const direct = parameters.filter((parameter) => parameter.ident.length > 0
    && /^(?:gainhighshelf[0-9]*|highshelf[0-9]*gain)$/u.test(normalizedParameterName(parameter.name)));
  const byName = new Map(parameters.map((parameter) => [normalizedParameterName(parameter.name), parameter]));
  const bandGains = parameters.filter((parameter) => /^band[0-9]+gain$/u.test(normalizedParameterName(parameter.name)));
  const provenBands = bandGains.filter((gain) => {
    const band = /^band([0-9]+)gain$/u.exec(normalizedParameterName(gain.name))?.[1];
    if (!band || !gain.ident) return false;
    const used = byName.get(`band${band}used`);
    const enabled = byName.get(`band${band}enabled`);
    const shape = byName.get(`band${band}shape`);
    const frequency = byName.get(`band${band}frequency`);
    return (used?.normalizedValue ?? 0) > 0.5
      && (enabled?.normalizedValue ?? 0) > 0.5
      && normalizedParameterName(shape?.formattedValue ?? "") === "highshelf"
      && (formattedFrequencyHz(frequency) ?? 0) >= 6000;
  });
  const matches = [...direct, ...provenBands];
  return matches.length === 1 ? matches[0] : undefined;
}

const semanticPreferences: Readonly<Record<string, SemanticPreference>> = {
  "semantic:airGain": {
    product: "Pro-Q 4",
    fx: "Pro-Q 4 (FabFilter)",
    select: selectAirGain,
  },
  "semantic:compressorThreshold": {
    product: "Pro-C 2",
    fx: "Pro-C 2 (FabFilter)",
    select: selectUnambiguousThreshold,
  },
  "semantic:deesserThreshold": {
    product: "Pro-DS",
    fx: "Pro-DS (FabFilter)",
    select: selectUnambiguousThreshold,
  },
};

export interface FabFilterMixPolicyOptions {
  readonly requester: BridgeRequester;
  readonly installed: readonly InstalledFabFilterPlugin[];
  readonly commandTimeoutMs?: number;
}

export class FabFilterMixPolicy {
  readonly #installed: ReadonlyMap<string, InstalledFabFilterPlugin>;

  public constructor(private readonly options: FabFilterMixPolicyOptions) {
    this.#installed = new Map(options.installed.map((plugin) => [plugin.product, plugin]));
  }

  public async resolve(plan: MixPlan): Promise<MixPlan> {
    if (!plan.actions.some((action) =>
      action.type === "fx.parameter.delta" && semanticPreferences[action.parameter])) {
      return plan;
    }
    const projectFx = await this.#projectFx();
    if (!projectFx) return plan;
    const proven = new Map<string, ProvenTarget | undefined>();
    const actions: MixAction[] = [];
    for (const action of plan.actions) {
      if (action.type !== "fx.parameter.delta") {
        actions.push(action);
        continue;
      }
      const preference = semanticPreferences[action.parameter];
      const candidates = projectFx.get(action.track.guid)?.flatMap((fx) => {
        const identity = supportedInstance(fx.name);
        if (!identity || identity.name !== preference?.fx || !fx.enabled || fx.offline) return [];
        return [{ fx, identity }];
      }) ?? [];
      if (!preference || candidates.length !== 1) {
        actions.push(action);
        continue;
      }
      const candidate = candidates[0]!;
      const proofKey = `${action.track.guid}\u0000${candidate.fx.guid}\u0000${action.parameter}`;
      let selected = proven.get(proofKey);
      if (!proven.has(proofKey)) {
        selected = await this.#probe(preference, action.track, candidate.fx, candidate.identity.format);
        proven.set(proofKey, selected);
      }
      actions.push(selected ? { ...action, ...selected } : action);
    }
    return actions.every((action, index) => action === plan.actions[index])
      ? plan
      : { ...plan, actions };
  }

  async #projectFx(): Promise<ReadonlyMap<string, readonly ProjectFx[]> | undefined> {
    try {
      const receipt = await this.options.requester.request({
        sessionId: "fabfilter-mix-policy-probe",
        operation: "project.snapshot",
        timeoutMs: this.options.commandTimeoutMs ?? 30_000,
        payload: {},
      });
      if (receipt.status !== "succeeded") return undefined;
      const project = projectFxSchema.parse(receipt.result);
      return new Map(project.tracks.map((track) => [
        track.guid,
        track.fx,
      ]));
    } catch {
      return undefined;
    }
  }

  async #probe(
    preference: SemanticPreference,
    track: FxAction["track"],
    instance: ProjectFx,
    format: "VST3" | "CLAP",
  ): Promise<ProvenTarget | undefined> {
    const plugin = this.#installed.get(preference.product);
    if (!plugin || plugin.automation !== "profiled" || !plugin.installations.some((installation) =>
      installation.format === format && installation.reaperName === preference.fx)) {
      return undefined;
    }
    try {
      const receipt = await this.options.requester.request({
        sessionId: "fabfilter-mix-policy-probe",
        operation: "fx.probe",
        timeoutMs: this.options.commandTimeoutMs ?? 30_000,
        payload: { plugin: preference.fx, format, track, fxGuid: instance.guid },
      });
      if (receipt.status !== "succeeded") return undefined;
      const result = fabFilterProbeResultSchema.parse(receipt.result);
      if (result.plugin !== preference.fx || result.format !== format) return undefined;
      const parameter = preference.select(result.parameters);
      return parameter
        ? { fx: preference.fx, fxFormat: format, fxGuid: instance.guid, parameterIdent: parameter.ident }
        : undefined;
    } catch {
      return undefined;
    }
  }
}
