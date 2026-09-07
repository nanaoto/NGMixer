import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const jsonValue: z.ZodType<unknown> = z.json();
const eventInputSchema = z.strictObject({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  kind: z.enum([
    "communication.received",
    "communication.accepted",
    "communication.sent",
    "mix.analysis-captured",
    "mix.plan-created",
    "mix.iteration.completed",
    "mix.iteration.failed",
    "mix.effect-adjusted",
    "mix.chain-snapshotted",
    "demo.render-completed",
    "demo.rendered",
    "feedback.received",
  ]),
  actor: z.strictObject({
    platform: z.enum(["qq", "agent", "reaper", "operator"]),
    id: z.string().min(1),
    displayName: z.string().optional(),
  }),
  payload: jsonValue,
  training: z.strictObject({
    use: z.enum(["unknown", "allowed", "denied"]),
    contentClass: z.enum(["group-message", "audio-artifact", "mix-provenance", "system-output"]),
  }),
}).superRefine((event, context) => {
  if (event.kind !== "mix.effect-adjusted") return;
  const payload = event.payload;
  const requiredStrings = ["track", "plugin", "parameter", "reason", "sourceEventId"];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    context.addIssue({ code: "custom", path: ["payload"], message: "effect adjustment payload must be an object" });
    return;
  }
  const fields = payload as Record<string, unknown>;
  for (const field of requiredStrings) {
    const value = fields[field];
    if (typeof value !== "string" || value.length === 0) {
      context.addIssue({ code: "custom", path: ["payload", field], message: `${field} is required` });
    }
  }
  for (const field of ["before", "after"]) {
    if (!(field in fields)) {
      context.addIssue({ code: "custom", path: ["payload", field], message: `${field} is required` });
    }
  }
});

export type EventInput = z.infer<typeof eventInputSchema>;
export type LedgerEvent = EventInput & {
  readonly schema: "rma.session-event/v1";
  readonly occurredAt: string;
};

export class EventLedger {
  private appendQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly path: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  public async append(input: EventInput): Promise<LedgerEvent> {
    const event: LedgerEvent = {
      schema: "rma.session-event/v1",
      occurredAt: this.now(),
      ...eventInputSchema.parse(input),
    };
    const persist = this.appendQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.appendQueue = persist.catch(() => undefined);
    await persist;
    return event;
  }

  public async readAll(): Promise<LedgerEvent[]> {
    try {
      const contents = await readFile(this.path, "utf8");
      return contents.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LedgerEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
