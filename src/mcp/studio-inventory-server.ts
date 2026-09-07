import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const inventorySchema = z.strictObject({
  schema: z.literal("rma.studio-inventory/v1"),
  scannedAt: z.string().datetime(),
  reaperPlugins: z.array(z.strictObject({
    name: z.string().min(1).max(500),
    format: z.enum(["VST", "VST3", "CLAP"]),
    cacheKey: z.string().min(1).max(1_024),
    status: z.enum(["recognized", "failed"]),
  })).max(20_000),
  pluginBundles: z.array(z.strictObject({
    name: z.string().min(1).max(500),
    format: z.enum(["VST", "VST3", "CLAP", "AU", "unknown"]),
    path: z.string().min(1).max(4_096),
  })).max(20_000),
  soundLibraries: z.array(z.strictObject({
    product: z.string().min(1).max(500),
    path: z.string().min(1).max(4_096),
    family: z.enum(["Kontakt", "Spectrasonics", "Waves", "other"]),
  })).max(20_000),
});

type StudioInventory = z.infer<typeof inventorySchema>;

async function loadInventory(path: string): Promise<StudioInventory> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > 5 * 1024 * 1024) {
    throw new Error("studio inventory must be a regular file no larger than 5 MiB");
  }
  return inventorySchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

function response(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

export function createStudioInventoryMcpServer(inventoryPath: string): McpServer {
  const server = new McpServer({ name: "reaper-studio-inventory", version: "0.1.0" });
  server.registerTool("status", {
    title: "Inspect local studio inventory",
    description: "Report when the local REAPER plug-in inventory was scanned and how many entries it contains.",
    outputSchema: {
      schema: z.literal("rma.studio-inventory-status/v1"),
      scannedAt: z.string(),
      recognizedPlugins: z.number().int().nonnegative(),
      failedPlugins: z.number().int().nonnegative(),
      pluginBundles: z.number().int().nonnegative(),
      soundLibraries: z.number().int().nonnegative(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const inventory = await loadInventory(inventoryPath);
    return response({
      schema: "rma.studio-inventory-status/v1",
      scannedAt: inventory.scannedAt,
      recognizedPlugins: inventory.reaperPlugins.filter((plugin) => plugin.status === "recognized").length,
      failedPlugins: inventory.reaperPlugins.filter((plugin) => plugin.status === "failed").length,
      pluginBundles: inventory.pluginBundles.length,
      soundLibraries: inventory.soundLibraries.length,
    });
  });
  server.registerTool("search_plugins", {
    title: "Search local REAPER plug-ins",
    description: "Search the bounded plug-in inventory created during first-run setup. Recognized REAPER entries are returned before failed or bundle-only entries.",
    inputSchema: {
      query: z.string().trim().min(1).max(200),
      includeFailed: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
    },
    outputSchema: {
      schema: z.literal("rma.studio-plugin-search/v1"),
      scannedAt: z.string(),
      plugins: z.array(z.object({
        name: z.string(),
        format: z.enum(["VST", "VST3", "CLAP", "AU", "unknown"]),
        status: z.enum(["recognized", "failed", "bundle-only"]),
        reaperName: z.string().optional(),
      })),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ query, includeFailed, limit }) => {
    const inventory = await loadInventory(inventoryPath);
    const needle = query.toLocaleLowerCase();
    const reaperPlugins = inventory.reaperPlugins
      .filter((plugin) => (includeFailed || plugin.status === "recognized")
        && `${plugin.name} ${plugin.cacheKey} ${plugin.format}`.toLocaleLowerCase().includes(needle))
      .map((plugin) => ({
        name: plugin.name,
        format: plugin.format,
        status: plugin.status,
        reaperName: plugin.name,
      }));
    const bundles = inventory.pluginBundles
      .filter((plugin) => `${plugin.name} ${plugin.format}`.toLocaleLowerCase().includes(needle))
      .map((plugin) => ({ name: plugin.name, format: plugin.format, status: "bundle-only" as const }));
    return response({
      schema: "rma.studio-plugin-search/v1",
      scannedAt: inventory.scannedAt,
      plugins: [...reaperPlugins, ...bundles].slice(0, limit),
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
  await createStudioInventoryMcpServer(requiredArgument("--inventory"))
    .connect(new StdioServerTransport());
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
