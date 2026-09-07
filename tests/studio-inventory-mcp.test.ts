import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Studio Inventory MCP lets DSH search the plug-ins captured during onboarding", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rma-studio-inventory-mcp-"));
  const inventoryPath = join(root, "catalog", "studio-inventory.json");
  await mkdir(join(root, "catalog"), { recursive: true });
  await writeFile(inventoryPath, JSON.stringify({
    schema: "rma.studio-inventory/v1",
    scannedAt: "2026-08-22T00:00:00.000Z",
    reaperPlugins: [
      { name: "FabFilter Pro-Q 4", format: "VST3", cacheKey: "pro-q.vst3", status: "recognized" },
      { name: "Legacy EQ", format: "VST", cacheKey: "legacy.vst", status: "failed" },
    ],
    pluginBundles: [],
    soundLibraries: [],
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import=tsx", join(process.cwd(), "src/mcp/studio-inventory-server.ts"), "--inventory", inventoryPath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "studio-inventory-contract", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);

  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["search_plugins", "status"]);
  const found = await client.callTool({ name: "search_plugins", arguments: { query: "pro-q" } });
  assert.deepEqual(found.structuredContent, {
    schema: "rma.studio-plugin-search/v1",
    scannedAt: "2026-08-22T00:00:00.000Z",
    plugins: [{ name: "FabFilter Pro-Q 4", format: "VST3", status: "recognized", reaperName: "FabFilter Pro-Q 4" }],
  });
});
