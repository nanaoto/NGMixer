import { createHash } from "node:crypto";

import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BridgeOperation =
  | "bridge.health"
  | "project.snapshot"
  | "analysis.capture"
  | "project.bootstrap"
  | "project.rebuild"
  | "media.import"
  | "fx.probe"
  | "docs.generate"
  | "transaction.execute"
  | "render.create";

export interface BridgeCommand {
  readonly schema: "rma.bridge-command/v1";
  readonly protocol_version: 1;
  readonly command_id: string;
  readonly session_id: string;
  readonly bridge_instance_id: string;
  readonly created_at: string;
  readonly deadline_at: string;
  readonly operation: BridgeOperation;
  readonly expected_project_id?: string;
  readonly expected_snapshot_hash?: string;
  readonly payload: JsonValue;
  readonly payload_sha256: string;
}

const receiptSchema = z.strictObject({
  schema: z.literal("rma.bridge-receipt/v1"),
  protocol_version: z.literal(1),
  command_id: z.string().uuid(),
  status: z.enum(["succeeded", "rejected", "failed", "recovery_required"]),
  started_at: z.string(),
  finished_at: z.string(),
  before_snapshot_hash: z.string().optional(),
  after_snapshot_hash: z.string().optional(),
  artifacts: z.array(z.unknown()),
  warnings: z.array(z.string()),
  error: z.unknown().nullable(),
  result: z.unknown().optional(),
});

export type BridgeReceipt = z.infer<typeof receiptSchema>;

export function parseReceipt(value: unknown): BridgeReceipt {
  return receiptSchema.parse(value);
}

export function requireSuccessfulBridgeResult(
  receipt: BridgeReceipt,
  operation: BridgeOperation,
): unknown {
  if (receipt.status === "succeeded") return receipt.result;
  const error = receipt.error as { message?: unknown } | null;
  const detail = error && typeof error.message === "string" ? `: ${error.message}` : "";
  throw new Error(`REAPER ${operation} ${receipt.status}${detail}`);
}

function stableValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = stableValue(value[key] as JsonValue);
    return sorted;
  }
  return value;
}

export function stableJson(value: JsonValue): string {
  return JSON.stringify(stableValue(value));
}

export function payloadSha256(payload: JsonValue): string {
  return `sha256:${createHash("sha256").update(stableJson(payload)).digest("hex")}`;
}
