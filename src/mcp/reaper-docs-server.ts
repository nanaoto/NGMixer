import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BridgeSpool } from "../bridge/spool.js";
import { readBridgeStatuses } from "../bridge/heartbeat.js";
import { loadConfig } from "../config.js";
import { ReaperApiReference } from "./reaper-docs-reference.js";

const generatedDocsReceiptSchema = z.strictObject({
  fileName: z.literal("reascripthelp.html"),
  reaperVersion: z.string().min(1).max(100),
  tempDirectory: z.string().min(1).max(1_024),
});

const readyStatusSchema = z.object({
  schema: z.literal("rma.reaper-docs-status/v1"),
  ready: z.literal(true),
  reaperVersion: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const unavailableStatusSchema = z.object({
  schema: z.literal("rma.reaper-docs-status/v1"),
  ready: z.literal(false),
  reason: z.enum(["bridge-unavailable", "stale"]).optional(),
  cachedReaperVersion: z.string().max(100).optional(),
  activeReaperVersion: z.string().max(100).optional(),
});

type ReadyStatus = z.infer<typeof readyStatusSchema>;
type ReaperDocsStatus = ReadyStatus | z.infer<typeof unavailableStatusSchema>;

function textAndStructured(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function readRegularBoundedFile(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("REAPER documentation source must be a regular file");
  if (stat.size < 100 || stat.size > 32 * 1024 * 1024) {
    throw new Error("REAPER documentation source has an invalid size");
  }
  return readFile(path, "utf8");
}

function isAllowedGeneratedRoot(generatedRoot: string, processTempRoot: string): boolean {
  if (generatedRoot === processTempRoot) return true;
  return process.platform === "darwin"
    && /^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/u.test(generatedRoot);
}

class ReaperDocsRepository {
  readonly #configPath: string;
  readonly #bridgeInstanceId: string;

  public constructor(configPath: string, bridgeInstanceId: string) {
    this.#configPath = configPath;
    this.#bridgeInstanceId = bridgeInstanceId;
  }

  async #cachePath(): Promise<string> {
    const config = await loadConfig(this.#configPath);
    return join(config.paths.runtimeRoot, "docs", "reaper", "reascripthelp.html");
  }

  async #load(): Promise<{ readonly reference: ReaperApiReference; readonly source: string }> {
    const source = await readRegularBoundedFile(await this.#cachePath());
    return { reference: ReaperApiReference.fromGeneratedHtml(source), source };
  }

  async #activeReaperVersion(runtimeRoot: string): Promise<string | undefined> {
    const heartbeat = (await readBridgeStatuses(runtimeRoot)).find(
      (candidate) => candidate.bridge_instance_id === this.#bridgeInstanceId,
    );
    if (!heartbeat) return undefined;
    const observedAt = Date.parse(heartbeat.observed_at);
    if (!Number.isFinite(observedAt) || Date.now() - observedAt > 5_000) return undefined;
    return heartbeat.reaper_version;
  }

  async #loadCurrent(): Promise<{ readonly reference: ReaperApiReference; readonly source: string }> {
    const loaded = await this.#load();
    const config = await loadConfig(this.#configPath);
    const activeReaperVersion = await this.#activeReaperVersion(config.paths.runtimeRoot);
    if (!activeReaperVersion || activeReaperVersion !== loaded.reference.reaperVersion) {
      throw new Error("REAPER documentation is not validated for the active bridge version");
    }
    return loaded;
  }

  public async status(): Promise<ReaperDocsStatus> {
    try {
      const { reference, source } = await this.#load();
      const config = await loadConfig(this.#configPath);
      const activeReaperVersion = await this.#activeReaperVersion(config.paths.runtimeRoot);
      if (!activeReaperVersion) {
        return {
          schema: "rma.reaper-docs-status/v1",
          ready: false,
          reason: "bridge-unavailable",
          cachedReaperVersion: reference.reaperVersion,
        };
      }
      if (activeReaperVersion !== reference.reaperVersion) {
        return {
          schema: "rma.reaper-docs-status/v1",
          ready: false,
          reason: "stale",
          cachedReaperVersion: reference.reaperVersion,
          activeReaperVersion,
        };
      }
      return {
        schema: "rma.reaper-docs-status/v1",
        ready: true,
        reaperVersion: reference.reaperVersion,
        sha256: sha256(source),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schema: "rma.reaper-docs-status/v1", ready: false };
      }
      throw error;
    }
  }

  public async refresh(): Promise<ReadyStatus> {
    const config = await loadConfig(this.#configPath);
    const spool = new BridgeSpool(config.paths.runtimeRoot, this.#bridgeInstanceId, {
      pollIntervalMs: config.reaper.pollIntervalMs,
    });
    const command = await spool.submitCommand({
      sessionId: `reaper-docs-refresh-${new Date().toISOString()}-${randomUUID()}`,
      operation: "docs.generate",
      timeoutMs: config.reaper.commandTimeoutMs,
      payload: {},
    });
    const receipt = await spool.waitForReceipt(command.command_id, config.reaper.commandTimeoutMs);
    if (receipt.status !== "succeeded") throw new Error(`REAPER documentation generation ${receipt.status}`);
    const generated = generatedDocsReceiptSchema.parse(receipt.result);
    let generatedRoot: string;
    try {
      generatedRoot = await realpath(generated.tempDirectory);
    } catch {
      throw new Error("REAPER documentation temporary directory is unavailable");
    }
    const processTempRoot = await realpath(tmpdir());
    if (!isAllowedGeneratedRoot(generatedRoot, processTempRoot)) {
      throw new Error("REAPER documentation source is outside an allowed temporary directory");
    }
    const generatedPath = join(generatedRoot, generated.fileName);
    if (await realpath(dirname(generatedPath)) !== generatedRoot) {
      throw new Error("REAPER documentation source escaped the system temporary directory");
    }
    const source = await readRegularBoundedFile(generatedPath);
    const reference = ReaperApiReference.fromGeneratedHtml(source);
    if (reference.reaperVersion !== generated.reaperVersion) {
      throw new Error("REAPER documentation version does not match the generating bridge");
    }
    const cachePath = await this.#cachePath();
    await mkdir(dirname(cachePath), { recursive: true });
    const temporaryPath = join(dirname(cachePath), `.reascripthelp-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(source, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, cachePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return {
      schema: "rma.reaper-docs-status/v1",
      ready: true,
      reaperVersion: reference.reaperVersion,
      sha256: sha256(source),
    };
  }

  public async reference(): Promise<ReaperApiReference> {
    return (await this.#loadCurrent()).reference;
  }
}

export function createReaperDocsMcpServer(configPath: string, bridgeInstanceId = "main"): McpServer {
  const repository = new ReaperDocsRepository(configPath, bridgeInstanceId);
  const server = new McpServer({ name: "reaper-docs", version: "0.1.0" });
  server.registerTool("status", {
    title: "Inspect local REAPER documentation status",
    description: "Report whether a validated, versioned copy of REAPER's locally generated ReaScript API reference is available.",
    outputSchema: {
      schema: z.literal("rma.reaper-docs-status/v1"),
      ready: z.boolean(),
      reaperVersion: z.string().max(100).optional(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
      reason: z.enum(["bridge-unavailable", "stale"]).optional(),
      cachedReaperVersion: z.string().max(100).optional(),
      activeReaperVersion: z.string().max(100).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => textAndStructured(await repository.status()));
  server.registerTool("refresh", {
    title: "Refresh local REAPER API documentation",
    description: "Ask the deterministic REAPER bridge to run native action 41065, validate the generated reascripthelp.html, and atomically cache the version-matched reference.",
    outputSchema: {
      schema: z.literal("rma.reaper-docs-status/v1"),
      ready: z.literal(true),
      reaperVersion: z.string().max(100),
      sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => textAndStructured(await repository.refresh()));
  server.registerTool("search", {
    title: "Search local REAPER API documentation",
    description: "Search the cached, locally generated REAPER ReaScript reference by API name, signature, or documented behavior. Returns bounded excerpts only.",
    inputSchema: {
      query: z.string().trim().min(1).max(200),
      limit: z.number().int().min(1).max(20).default(8),
    },
    outputSchema: {
      schema: z.literal("rma.reaper-docs-search/v1"),
      reaperVersion: z.string().max(100),
      results: z.array(z.object({
        name: z.string().max(128),
        luaSignature: z.string().max(2_000),
        excerpt: z.string().max(1_200),
      })),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ query, limit }) => {
    const reference = await repository.reference();
    return textAndStructured({
      schema: "rma.reaper-docs-search/v1",
      reaperVersion: reference.reaperVersion,
      results: reference.search(query, limit),
    });
  });
  server.registerTool("describe_api", {
    title: "Describe one local REAPER API function",
    description: "Return the exact Lua signature and bounded description for one function from the cached, locally generated REAPER reference.",
    inputSchema: { name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u) },
    outputSchema: {
      schema: z.literal("rma.reaper-api-entry/v1"),
      reaperVersion: z.string().max(100),
      entry: z.object({
        name: z.string().max(128),
        luaSignature: z.string().max(2_000),
        description: z.string().max(4_000),
        truncated: z.boolean(),
      }),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ name }) => {
    const reference = await repository.reference();
    const entry = reference.describeApi(name);
    if (!entry) throw new Error(`REAPER API function is not documented by this version: ${name}`);
    return textAndStructured({
      schema: "rma.reaper-api-entry/v1",
      reaperVersion: reference.reaperVersion,
      entry,
    });
  });
  return server;
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const bridgeIndex = process.argv.indexOf("--bridge-instance");
  const bridgeInstanceId = bridgeIndex < 0 ? "main" : process.argv[bridgeIndex + 1];
  if (!bridgeInstanceId || bridgeInstanceId.startsWith("--")) throw new Error("--bridge-instance needs a value");
  await createReaperDocsMcpServer(requiredArgument("--config"), bridgeInstanceId)
    .connect(new StdioServerTransport());
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
