import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const heartbeatSchema = z.strictObject({
  schema: z.literal("rma.bridge-heartbeat/v1"),
  bridge_instance_id: z.string().min(1),
  protocol_version: z.literal(1),
  observed_at: z.string(),
  reaper_version: z.string(),
  project_id: z.string(),
  project_change_count: z.number().int(),
  state: z.enum(["idle", "busy", "recovery_required", "incompatible", "stopped"]),
  active_command_id: z.string().uuid().nullable(),
});

export type BridgeHeartbeat = z.infer<typeof heartbeatSchema>;

export async function readBridgeStatuses(runtimeRoot: string): Promise<BridgeHeartbeat[]> {
  const root = join(runtimeRoot, "bridge");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const heartbeats: BridgeHeartbeat[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const value = heartbeatSchema.parse(
        JSON.parse(await readFile(join(root, entry.name, "heartbeat.json"), "utf8")),
      );
      if (value.bridge_instance_id !== entry.name) throw new Error("bridge instance mismatch");
      heartbeats.push(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`invalid heartbeat ${entry.name}`, { cause: error });
    }
  }
  return heartbeats;
}
