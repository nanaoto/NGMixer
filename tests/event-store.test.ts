import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventLedger } from "../src/ledger/event-store.js";

test("event ledger preserves conversation and effect changes as append-only JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-ledger-"));
  const path = join(directory, "events.jsonl");
  const ledger = new EventLedger(path, () => "2026-08-19T00:00:00.000Z");

  await ledger.append({
    eventId: "evt-1",
    sessionId: "session-1",
    iteration: 1,
    kind: "communication.received",
    actor: { platform: "qq", id: "10001", displayName: "Singer" },
    payload: { text: "主唱再靠前一点" },
    training: { use: "unknown", contentClass: "group-message" },
  });
  await ledger.append({
    eventId: "evt-2",
    sessionId: "session-1",
    iteration: 2,
    kind: "mix.effect-adjusted",
    actor: { platform: "agent", id: "mixing-agent" },
    payload: {
      track: "LEAD VOCAL",
      plugin: "FabFilter Pro-C 2",
      parameter: "threshold_db",
      before: -18,
      after: -21,
      reason: "主唱再靠前一点",
      sourceEventId: "evt-1",
    },
    training: { use: "unknown", contentClass: "mix-provenance" },
  });

  const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines, await ledger.readAll());
});

test("event ledger rejects incomplete effect provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-ledger-"));
  const ledger = new EventLedger(join(directory, "events.jsonl"));
  await assert.rejects(ledger.append({
    eventId: "evt-incomplete",
    sessionId: "session-1",
    iteration: 1,
    kind: "mix.effect-adjusted",
    actor: { platform: "agent", id: "mixing-agent" },
    payload: { plugin: "Pro-Q 4" },
    training: { use: "unknown", contentClass: "mix-provenance" },
  }), /track is required/);
});
