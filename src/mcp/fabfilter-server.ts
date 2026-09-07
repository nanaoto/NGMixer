import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BridgeSpool } from "../bridge/spool.js";
import { loadConfig } from "../config.js";
import {
  describeFabFilterProduct,
  installedFabFilterPlugins,
} from "./fabfilter-catalog.js";
import { fabFilterProbeResultSchema } from "./fabfilter-protocol.js";

function textAndStructured(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

async function probeProduct(configPath: string, bridgeInstanceId: string, product: string) {
  const [config, installed] = await Promise.all([
    loadConfig(configPath),
    installedFabFilterPlugins(configPath),
  ]);
  const plugin = installed.find((candidate) => candidate.product === product);
  if (!plugin) throw new Error(`FabFilter product is not recognized by REAPER: ${product}`);
  if (plugin.automation !== "profiled") {
    throw new Error(`FabFilter product has inventory only and cannot be probed yet: ${product}`);
  }
  const spool = new BridgeSpool(config.paths.runtimeRoot, bridgeInstanceId, {
    pollIntervalMs: config.reaper.pollIntervalMs,
  });
  const command = await spool.submitCommand({
    sessionId: "fabfilter-mcp-probe",
    operation: "fx.probe",
    timeoutMs: config.reaper.commandTimeoutMs,
    payload: {
      plugin: plugin.preferredInstallation.reaperName,
      format: plugin.preferredInstallation.format,
    },
  });
  const receipt = await spool.waitForReceipt(command.command_id, config.reaper.commandTimeoutMs);
  if (receipt.status !== "succeeded") {
    const detail = receipt.error as { message?: unknown } | null;
    throw new Error(
      `REAPER FabFilter probe ${receipt.status}${typeof detail?.message === "string" ? `: ${detail.message}` : ""}`,
    );
  }
  const result = fabFilterProbeResultSchema.parse(receipt.result);
  if (result.plugin !== plugin.preferredInstallation.reaperName
    || result.format !== plugin.preferredInstallation.format) {
    throw new Error("REAPER probed a different plug-in installation");
  }
  return {
    schema: "rma.fabfilter-probe/v1" as const,
    product,
    reaperName: result.plugin,
    format: result.format,
    parameters: result.parameters,
  };
}

export function createFabFilterMcpServer(configPath: string, bridgeInstanceId = "main"): McpServer {
  const server = new McpServer({ name: "reaper-fabfilter", version: "0.1.0" });
  server.registerTool("list_installed", {
    title: "List installed FabFilter plug-ins",
    description: "List FabFilter VST3/CLAP plug-ins that the current REAPER cache recognizes. Failed legacy VST entries are excluded.",
    outputSchema: {
      schema: z.literal("rma.fabfilter-installed/v1"),
      plugins: z.array(z.object({
        product: z.string(),
        formats: z.array(z.enum(["VST3", "CLAP"])),
        preferredReaperName: z.string(),
        installations: z.array(z.object({
          format: z.enum(["VST3", "CLAP"]),
          reaperCacheKey: z.string().min(1),
          reaperName: z.string().min(1),
        })),
        preferredInstallation: z.object({
          format: z.enum(["VST3", "CLAP"]),
          reaperCacheKey: z.string().min(1),
          reaperName: z.string().min(1),
        }),
        automation: z.enum(["profiled", "inventory-only"]),
      })),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async () => textAndStructured({
    schema: "rma.fabfilter-installed/v1",
    plugins: await installedFabFilterPlugins(configPath),
  }));
  server.registerTool("describe", {
    title: "Describe a FabFilter plug-in",
    description: "Describe the bounded semantic controls currently profiled for one FabFilter product. Inventory-only products are never presented as safely automatable.",
    inputSchema: { product: z.string().min(1).max(100) },
    outputSchema: {
      schema: z.literal("rma.fabfilter-capability/v1"),
      product: z.string(),
      category: z.string(),
      semanticControls: z.array(z.string()),
      automation: z.enum(["profiled", "inventory-only"]),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ product }) => textAndStructured({ ...describeFabFilterProduct(product) }));
  server.registerTool("probe", {
    title: "Probe a FabFilter plug-in in REAPER",
    description: "Ask the deterministic REAPER bridge to instantiate a profiled FabFilter plug-in on a disposable track, enumerate its actual automation parameters, and remove the track before returning.",
    inputSchema: { product: z.string().min(1).max(100) },
    outputSchema: {
      schema: z.literal("rma.fabfilter-probe/v1"),
      product: z.string(),
      reaperName: z.string(),
      format: z.enum(["VST3", "CLAP"]),
      parameters: z.array(z.object({
        index: z.number().int().nonnegative(),
        name: z.string(),
        ident: z.string(),
        normalizedValue: z.number().min(0).max(1),
        formattedValue: z.string(),
      })),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ product }) => textAndStructured(await probeProduct(configPath, bridgeInstanceId, product)));
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
  const server = createFabFilterMcpServer(requiredArgument("--config"), bridgeInstanceId);
  await server.connect(new StdioServerTransport());
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
