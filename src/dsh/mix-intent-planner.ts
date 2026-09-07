import {
  createUserMessage,
  LlmError,
  type GenerateOptions,
  type LlmFailure,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";

import type { LlmModelSelection } from "../config.js";
import { isEndpointUnavailableFailure } from "./model-failover-plugin.js";
import {
  mixIntentPlannerInstructions,
  parseModelMixPlan,
  type CompileMixIntentInput,
  type MixIntentPlanner,
  type MixPlan,
} from "../mixing/intent-compiler.js";
import {
  appendMixingKnowledge,
  FileMixingKnowledgeLibrary,
  mixingKnowledgeEvidence,
  type MixingKnowledgeLibrary,
} from "../mixing/knowledge-pack.js";

export interface RoutedLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

function terminalModelError(failure: LlmFailure): LlmError {
  return new LlmError(failure.message, failure.code, {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.providerRetryAfterMs === undefined
      ? {}
      : { providerRetryAfterMs: failure.providerRetryAfterMs }),
    ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
  });
}

export class DshMixIntentPlanner implements MixIntentPlanner {
  public constructor(
    private readonly llm: RoutedLlm,
    private readonly selection: LlmModelSelection | (() => LlmModelSelection),
    private readonly knowledge: MixingKnowledgeLibrary = new FileMixingKnowledgeLibrary(),
  ) {}

  public async plan(input: CompileMixIntentInput): Promise<MixPlan> {
    const knowledgeSelection = await this.knowledge.search({
      query: [
        input.text,
        ...(input.analysis?.tracks.flatMap((track) => [track.name, ...track.fx.map((fx) => fx.name)]) ?? []),
      ].join("\n"),
      limit: 6,
    });
    const userMessage = createUserMessage({
      content: [{
        type: "text",
        text: JSON.stringify({
          feedback: input.text,
          ...(input.analysis === undefined ? {} : { analysis: input.analysis }),
          ...(input.context === undefined ? {} : { context: input.context }),
        }),
      }],
      source: { kind: "plugin", plugin: "reaper-mixing-agent" },
    });
    let content = "";
    let completed = false;
    const selection = typeof this.selection === "function" ? this.selection() : this.selection;
    const routes = [
      { provider: selection.provider, model: selection.model },
      ...(selection.fallbacks ?? []),
    ];
    for (const [index, route] of routes.entries()) {
      content = "";
      let finished = false;
      let useNextRoute = false;
      for await (const chunk of this.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [userMessage],
        system: appendMixingKnowledge(mixIntentPlannerInstructions, knowledgeSelection),
        maxTokens: 2048,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })) {
        if (chunk.type === "text-delta") content += chunk.text;
        if (chunk.type !== "finish") continue;
        finished = true;
        if (chunk.reason.kind === "error") {
          if (index + 1 < routes.length && isEndpointUnavailableFailure(chunk.reason.failure)) {
            useNextRoute = true;
            break;
          }
          throw terminalModelError(chunk.reason.failure);
        }
        if (chunk.reason.kind === "aborted") {
          throw terminalModelError(chunk.reason.failure);
        }
        if (chunk.reason.kind !== "stop") {
          throw new Error(`DSH mix intent model ended with ${chunk.reason.kind}`);
        }
      }
      if (useNextRoute) continue;
      if (!finished) throw new Error("DSH mix intent model returned no finish event");
      completed = true;
      break;
    }
    if (!completed) throw new Error("DSH mix intent model exhausted its route pool");
    if (!content.trim()) throw new Error("DSH mix intent model returned no JSON content");
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new Error("DSH mix intent model returned invalid JSON");
    }
    if (!input.analysis) throw new Error("DSH mix planning requires a current track analysis");
    return {
      ...parseModelMixPlan(value, input.sourceEventId, input.text, input.analysis),
      knowledgePack: mixingKnowledgeEvidence(knowledgeSelection),
    };
  }
}
