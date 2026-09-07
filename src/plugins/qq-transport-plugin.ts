import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";

import {
  CommunicationError,
  JsonlCommunicationJournal,
  NapCatCommunicationModule,
} from "../communication/napcat-module.js";
import { LocalArtifactStore } from "../communication/artifact-store.js";
import type { CommunicationModule } from "../contracts/communication.js";
import { loadConfig } from "../config.js";
import { OneBotHttpGateway } from "../qq/onebot.js";
import { OneBotWebhookServer } from "../qq/webhook-server.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    communication: CommunicationModule;
  }
}

export const name = "qq-transport";
export const inject = [] as const;

export const Config = z.strictObject({
  configPath: z.string().min(1),
  napCatUrl: z.string().url(),
  outboundStagingRoot: z.string().min(1).refine(isAbsolute, "must be an absolute path"),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
  accountId: z.string().regex(/^[0-9]+$/u),
  groupId: z.string().regex(/^[0-9]+$/u),
  groupIds: z.array(z.string().regex(/^[0-9]+$/u)).optional(),
  privateUserIds: z.array(z.string().regex(/^[0-9]+$/u)).optional(),
  listenPort: z.number().int().min(0).max(65_535).optional(),
});

export type QqTransportPluginConfig = z.infer<typeof Config>;

export interface ManagedCommunicationModule extends CommunicationModule {
  start(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface QqTransportPluginDependencies {
  readonly createModule: (config: QqTransportPluginConfig) => Promise<ManagedCommunicationModule>;
  readonly waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const reconnectDelayMs = 5_000;

function isTemporarilyUnavailable(error: unknown): error is CommunicationError {
  return error instanceof CommunicationError && error.code === "RMA_COMM_UNAVAILABLE";
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  await delay(delayMs, undefined, { signal });
}

function loopbackNapCatUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new CommunicationError("RMA_COMM_SCOPE_MISMATCH", "NapCat HTTP server must use a loopback http URL");
  }
  return url.toString().replace(/\/$/u, "");
}

function credential(name: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
    throw new CommunicationError("RMA_COMM_SCOPE_MISMATCH", "NapCat token environment variable name is invalid");
  }
  const value = process.env[name];
  if (!value) throw new CommunicationError("RMA_COMM_UNAVAILABLE", `NapCat credential ${name} is missing`);
  return value;
}

async function createDefaultModule(config: QqTransportPluginConfig): Promise<ManagedCommunicationModule> {
  const local = await loadConfig(config.configPath);
  const token = credential(config.tokenEnv);
  const gateway = new OneBotHttpGateway(loopbackNapCatUrl(config.napCatUrl), fetch, token, "base64");
  const artifactStore = new LocalArtifactStore(join(local.paths.audioWorkRoot, "qq-imports"));
  const allowedGroupIds = [...new Set([config.groupId, ...(config.groupIds ?? [])])];
  const journalPath = join(
    local.paths.runtimeRoot,
    "communication",
    "qq",
    `${config.accountId}.jsonl`,
  );
  await assertNoLegacyQqJournals(local.paths.runtimeRoot, config.accountId, allowedGroupIds);
  return new NapCatCommunicationModule({
    gateway,
    journal: new JsonlCommunicationJournal(journalPath),
    accountId: config.accountId,
    groupId: config.groupId,
    allowedGroupIds,
    allowedPrivateUserIds: config.privateUserIds ?? [],
    replyWhenUnavailable: false,
    importAttachment: async (attachment, signal) => {
      if (!attachment.id) {
        // Image segments have no get_file id; NapCat serves them over plain HTTP.
        if (!attachment.url) throw new Error("QQ attachment has neither file id nor url");
        const response = await fetch(attachment.url, { signal });
        if (!response.ok) throw new Error(`QQ image download failed: HTTP ${response.status}`);
        const staging = join(local.paths.audioWorkRoot, "qq-imports", ".staging");
        await mkdir(staging, { recursive: true });
        const fileName = attachment.name ?? "image.jpg";
        const staged = join(staging, `${randomUUID()}-${fileName}`);
        await writeFile(staged, Buffer.from(await response.arrayBuffer()));
        try {
          return await artifactStore.importFile({ kind: attachment.kind, filePath: staged, fileName }, signal);
        } finally {
          await unlink(staged).catch(() => undefined);
        }
      }
      const resolved = await gateway.resolveAttachment(attachment.id);
      return artifactStore.importFile({
        kind: attachment.kind,
        filePath: resolved.filePath,
        fileName: resolved.fileName,
      }, signal);
    },
    resolveArtifact: (artifact, signal) => artifactStore.resolve(artifact, signal),
    host: local.network.daemonHost,
    port: config.listenPort ?? local.network.daemonPort,
    webhookToken: token,
    createWebhookServer: (options) => new OneBotWebhookServer({
      ...options,
      onEventIgnored: (detail) => {
        const line = JSON.stringify({
          occurredAt: new Date().toISOString(),
          ...detail,
        });
        void appendFile(
          join(local.paths.runtimeRoot, "communication", "qq", "dropped-events.jsonl"),
          `${line}\n`,
        ).catch(() => undefined);
      },
    }),
  });
}

export async function assertNoLegacyQqJournals(
  runtimeRoot: string,
  accountId: string,
  groupIds: readonly string[],
): Promise<void> {
  for (const groupId of groupIds) {
    const legacyPath = join(runtimeRoot, "communication", "qq", `${accountId}-${groupId}.jsonl`);
    try {
      const info = await stat(legacyPath);
      if (info.size > 0) {
        throw new CommunicationError(
          "RMA_COMM_UNAVAILABLE",
          `legacy QQ journal requires operator migration before startup: ${legacyPath}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export function createQqTransportPlugin(
  dependencies: QqTransportPluginDependencies = { createModule: createDefaultModule },
) {
  return {
    name,
    inject,
    Config,
    async apply(context: Context, config: QqTransportPluginConfig): Promise<() => Promise<void>> {
      const communication = await dependencies.createModule(config);
      const logger = context.logger(name);
      const reconnect = new AbortController();
      const retryWait = dependencies.waitForRetry ?? waitForRetry;
      let reconnectTask: Promise<void> | undefined;
      context.provide("communication", communication);
      try {
        await communication.start(reconnect.signal);
      } catch (startError) {
        if (isTemporarilyUnavailable(startError)) {
          logger.warn("NapCat is unavailable; QQ transport will retry in the background");
          reconnectTask = (async () => {
            while (!reconnect.signal.aborted) {
              try {
                await retryWait(reconnectDelayMs, reconnect.signal);
              } catch {
                if (reconnect.signal.aborted) return;
                logger.error("QQ transport reconnect timer failed: RMA_COMM_RETRY_TIMER_FAILED");
                return;
              }
              if (reconnect.signal.aborted) return;
              try {
                await communication.start(reconnect.signal);
                logger.info("QQ transport reconnected to NapCat");
                return;
              } catch (error) {
                if (isTemporarilyUnavailable(error)) {
                  logger.warn("NapCat is still unavailable; QQ transport will retry again");
                  continue;
                }
                logger.error(
                  "QQ transport reconnect stopped after a non-retryable startup error: %s",
                  error instanceof CommunicationError ? error.code : "RMA_COMM_START_FAILED",
                );
                return;
              }
            }
          })();
        } else {
          try {
            await communication.close();
          } catch (closeError) {
            throw new AggregateError([startError, closeError], "QQ transport startup and cleanup failed");
          }
          throw startError;
        }
      }
      return async () => {
        reconnect.abort();
        await reconnectTask;
        await communication.close();
      };
    },
  };
}

const plugin = createQqTransportPlugin();

export async function apply(
  context: Context,
  config: QqTransportPluginConfig,
): Promise<() => Promise<void>> {
  return plugin.apply(context, config);
}
