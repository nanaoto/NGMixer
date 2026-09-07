import { z } from "zod";

import type { MixAnalysisSnapshot } from "./analysis.js";
import type { MixingKnowledgeEvidence } from "./knowledge-pack.js";

const safeDisplayName = z.string().trim().min(1).max(128).refine((value) =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  }), "track name must not contain control characters");

export const trackIdentitySchema = z.strictObject({
  guid: z.string().min(1).max(128),
  name: safeDisplayName,
});

export type TrackIdentity = z.infer<typeof trackIdentitySchema>;

const mixActionPlugin = z.enum([
  "ReaEQ (Cockos)",
  "ReaComp (Cockos)",
  "ReaXcomp (Cockos)",
  "ReaLimit (Cockos)",
  "Pro-Q 4 (FabFilter)",
  "Pro-C 2 (FabFilter)",
  "Pro-DS (FabFilter)",
  "Pro-L 2 (FabFilter)",
]);

const reason = z.string().min(1).max(200);

const trackGainAction = z.strictObject({
  type: z.literal("track.gain.delta"),
  track: trackIdentitySchema,
  deltaDb: z.number().min(-6).max(6),
  reason,
});

const sendGainAction = z.strictObject({
  type: z.literal("send.gain.delta"),
  from: trackIdentitySchema,
  to: trackIdentitySchema,
  deltaDb: z.number().min(-6).max(6),
  reason,
});

const parameterIdent = z.string().min(1).max(200).refine((value) =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  }), "parameterIdent must not contain control characters");

const modelFxParameterAction = z.strictObject({
  type: z.literal("fx.parameter.delta"),
  track: trackIdentitySchema,
  fx: mixActionPlugin,
  parameter: z.string().min(1).max(100),
  deltaNormalized: z.number().min(-0.2).max(0.2),
  reason,
});

const fxParameterAction = modelFxParameterAction.extend({
  fxFormat: z.enum(["VST3", "CLAP"]).optional(),
  fxGuid: z.string().regex(/^\{[0-9A-Za-z-]{1,64}\}$/u).optional(),
  parameterIdent: parameterIdent.optional(),
});

export const mixActionSchema = z.discriminatedUnion("type", [
  trackGainAction,
  sendGainAction,
  fxParameterAction,
]);

const modelMixActionSchema = z.discriminatedUnion("type", [
  trackGainAction,
  sendGainAction,
  modelFxParameterAction,
]);

const modelMixPlanSchema = z.strictObject({
  summary: z.string().min(1).max(500),
  actions: z.array(modelMixActionSchema).min(1).max(12),
  preservationConstraints: z.array(z.string().min(1).max(200)).max(6).default([]),
});

export type MixAction = z.infer<typeof mixActionSchema>;

export interface MixPlan {
  readonly schema: "rma.mix-plan/v2";
  readonly sourceEventId: string;
  readonly sourceText: string;
  readonly summary: string;
  readonly actions: readonly MixAction[];
  readonly preservationConstraints?: readonly string[];
  readonly parentSourceEventId?: string;
  readonly knowledgePack?: MixingKnowledgeEvidence;
}

export interface MixPlanningContext {
  readonly previousIteration?: number;
  readonly recentTurns: readonly Readonly<Record<string, unknown>>[];
}

export interface CompileMixIntentInput {
  readonly text: string;
  readonly sourceEventId: string;
  readonly context?: MixPlanningContext;
  readonly analysis?: MixAnalysisSnapshot;
  readonly signal?: AbortSignal;
}

export interface MixIntentPlanner {
  plan(input: CompileMixIntentInput): Promise<MixPlan>;
}

function referencedTracks(action: z.infer<typeof modelMixActionSchema>): readonly TrackIdentity[] {
  if (action.type === "send.gain.delta") return [action.from, action.to];
  return [action.track];
}

export function parseModelMixPlan(
  value: unknown,
  sourceEventId: string,
  sourceText: string,
  analysis: MixAnalysisSnapshot,
): MixPlan {
  const plan = modelMixPlanSchema.parse(value);
  const observed = new Map(analysis.tracks.map((track) => [track.trackGuid, track.name]));
  for (const action of plan.actions) {
    for (const track of referencedTracks(action)) {
      const observedName = observed.get(track.guid);
      if (observedName === undefined) {
        throw new Error(`mix plan references an unobserved track GUID: ${track.guid}`);
      }
      if (observedName !== track.name) {
        throw new Error(`mix plan track identity changed: ${track.guid}`);
      }
    }
  }
  return {
    schema: "rma.mix-plan/v2",
    sourceEventId,
    sourceText,
    summary: plan.summary,
    actions: mixActionSchema.array().min(1).max(12).parse(plan.actions),
    preservationConstraints: plan.preservationConstraints,
  };
}

export const mixIntentPlannerInstructions = `You create a bounded REAPER Mix Plan from Chinese or English feedback and the supplied pre-mutation analysis.
Return one JSON object with summary, actions, and preservationConstraints only. Never return prose or markdown.
The project topology is dynamic: track count, performers, vocal parts, instruments, buses, and returns can change every turn.
Never assume standard track names or a fixed template. Every track reference must be copied exactly from analysis as {"guid":TRACK_GUID,"name":TRACK_NAME}.
Only reference observed GUID/name pairs. A name is descriptive; the GUID is the mutation identity.
Allowed actions:
{"type":"track.gain.delta","track":TRACK_REF,"deltaDb":NUMBER,"reason":STRING}
{"type":"send.gain.delta","from":TRACK_REF,"to":TRACK_REF,"deltaDb":NUMBER,"reason":STRING}
{"type":"fx.parameter.delta","track":TRACK_REF,"fx":FX,"parameter":PARAMETER,"deltaNormalized":NUMBER,"reason":STRING}
Keep deltaDb within -6..6 and deltaNormalized within -0.2..0.2. Emit at most 12 conservative actions.
For semantic FX changes use only semantic:airGain, semantic:compressorThreshold, or semantic:deesserThreshold with the matching stock FX; the host policy may bind a proven FabFilter instance. Do not emit fxFormat, fxGuid, or parameterIdent.
Use mediaItemCount, FX, sends, hasSignal, and measured loudness as evidence. Do not invent a send or FX that is absent from the analyzed track. Do not treat floor-level numerical noise as musical signal, and do not change a silent track unless the user explicitly asks.
Apply deterministic [D] rules and perform available [O] observations yourself. Never ask the user to read meters, inspect tracks, calculate timing, choose technical parameters, or perform A/B on your behalf. Treat [H] rules only as hypotheses requiring current evidence.
Respect preservation constraints and do not collapse several performers or parts into one target. Return the user's constraints in preservationConstraints.`;
