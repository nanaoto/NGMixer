import type { MixPlan } from "./intent-compiler.js";

export interface AppliedMixAdjustment {
  readonly actionIndex: number;
  readonly track: string;
  readonly plugin: string;
  readonly parameter: string;
  readonly before: number;
  readonly after: number;
  /** Human-readable values (e.g. "85.000 Hz", "-1.50 dB") recorded at apply time. */
  readonly parameterName?: string | undefined;
  /** Band position/shape at apply time, e.g. "High Shelf @ 8066 Hz" (band indices drift). */
  readonly parameterContext?: string | undefined;
  /** Full parameter dump of the touched FX instance at apply time — exact reproduction. */
  readonly fxSnapshot?: readonly { name: string; formatted: string; normalized: number }[] | undefined;
  readonly beforeFormatted?: string | undefined;
  readonly afterFormatted?: string | undefined;
  readonly reason: string;
}

export interface RenderedDemoArtifact {
  readonly projectId: string;
  readonly path: string;
  readonly fileName: string;
  readonly sampleRate: 48_000;
  readonly channels: 2;
  readonly format: "wav";
  readonly bytes: number;
  readonly sha256: string;
  readonly renderBounds: "entire-project";
  readonly tailSeconds: number;
  /** project_id@change_count at render time; absent on pre-fix ledger entries (counts as stale). */
  readonly projectRevision?: string | undefined;
}

export interface MixRunRequest {
  readonly sessionId: string;
  readonly iteration: number;
  readonly plan: MixPlan;
  readonly recordAdjustments: (
    adjustments: readonly AppliedMixAdjustment[],
    phase: "applied" | "rollback",
  ) => Promise<void>;
}

export interface MixRunResult {
  readonly adjustments: readonly AppliedMixAdjustment[];
  readonly artifact: RenderedDemoArtifact;
}

export interface MixEngine {
  run(request: MixRunRequest): Promise<MixRunResult>;
}

export interface DemoRenderRequest {
  readonly sessionId: string;
  readonly iteration: number;
}

export interface DemoRenderer {
  render(request: DemoRenderRequest): Promise<RenderedDemoArtifact>;
  /** Current project_id@change_count; lets callers invalidate stale cached renders. */
  probeProjectRevision?(): Promise<string>;
}
