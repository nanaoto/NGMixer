import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type BridgeCommand,
  type BridgeOperation,
  type BridgeReceipt,
  type JsonValue,
  parseReceipt,
  payloadSha256,
} from "./protocol.js";

export interface SubmitCommandOptions {
  readonly sessionId: string;
  readonly operation: BridgeOperation;
  readonly timeoutMs: number;
  readonly expectedProjectId?: string;
  readonly expectedSnapshotHash?: string;
  readonly payload: JsonValue;
}

export interface BridgeSpoolOptions {
  readonly pollIntervalMs?: number;
}

export class BridgeTimeoutError extends Error {
  public constructor(commandId: string, timeoutMs: number) {
    super(`bridge receipt ${commandId} did not arrive within ${timeoutMs} ms`);
    this.name = "BridgeTimeoutError";
  }
}

export class BridgeSpool {
  readonly #bridgeRoot: string;
  readonly #bridgeInstanceId: string;
  readonly #pollIntervalMs: number;

  public constructor(runtimeRoot: string, bridgeInstanceId: string, options: BridgeSpoolOptions = {}) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bridgeInstanceId)) {
      throw new TypeError("bridge instance id must be a filename-safe identifier");
    }
    this.#bridgeRoot = join(runtimeRoot, "bridge", bridgeInstanceId);
    this.#bridgeInstanceId = bridgeInstanceId;
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
  }

  async #ensureDirectories(): Promise<void> {
    await Promise.all(
      [
        "commands/tmp",
        "commands/ready",
        "commands/claimed",
        "commands/finished",
        "receipts/tmp",
        "receipts/ready",
      ].map((directory) => mkdir(join(this.#bridgeRoot, directory), { recursive: true })),
    );
  }

  public async submitCommand(options: SubmitCommandOptions): Promise<BridgeCommand> {
    await this.#ensureDirectories();
    const commandId = randomUUID();
    const createdAt = new Date();
    const command: BridgeCommand = {
      schema: "rma.bridge-command/v1",
      protocol_version: 1,
      command_id: commandId,
      session_id: options.sessionId,
      bridge_instance_id: this.#bridgeInstanceId,
      created_at: createdAt.toISOString(),
      deadline_at: new Date(createdAt.getTime() + options.timeoutMs).toISOString(),
      operation: options.operation,
      ...(options.expectedProjectId === undefined
        ? {}
        : { expected_project_id: options.expectedProjectId }),
      ...(options.expectedSnapshotHash === undefined
        ? {}
        : { expected_snapshot_hash: options.expectedSnapshotHash }),
      payload: options.payload,
      payload_sha256: payloadSha256(options.payload),
    };
    const temporaryPath = join(this.#bridgeRoot, "commands/tmp", `${commandId}.json`);
    const readyPath = join(this.#bridgeRoot, "commands/ready", `${commandId}.json`);
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(command)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, readyPath);
    return command;
  }

  public async waitForReceipt(
    commandId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BridgeReceipt> {
    const receiptPath = join(this.#bridgeRoot, "receipts/ready", `${commandId}.json`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const receipt = parseReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
        if (receipt.command_id !== commandId) {
          throw new Error(`receipt command id does not match ${commandId}`);
        }
        return receipt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) throw new BridgeTimeoutError(commandId, timeoutMs);
      await delay(Math.min(this.#pollIntervalMs, Math.max(0, deadline - Date.now())), undefined, {
        signal,
      });
    }
  }
}
