import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface InstalledResult {
  readonly schema: "rma.fabfilter-installed/v1";
  readonly plugins: ReadonlyArray<{
    readonly product: string;
    readonly formats: readonly string[];
    readonly preferredReaperName: string;
    readonly installations: ReadonlyArray<{
      readonly format: string;
      readonly reaperCacheKey: string;
      readonly reaperName: string;
    }>;
    readonly preferredInstallation: {
      readonly format: string;
      readonly reaperCacheKey: string;
      readonly reaperName: string;
    };
    readonly automation: "profiled" | "inventory-only";
  }>;
}

interface DescriptionResult {
  readonly schema: "rma.fabfilter-capability/v1";
  readonly product: string;
  readonly semanticControls: readonly string[];
  readonly automation: "profiled" | "inventory-only";
}

async function answerProbeCommand(runtimeRoot: string): Promise<void> {
  const readyRoot = join(runtimeRoot, "bridge/main/commands/ready");
  let filename: string | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      filename = (await readdir(readyRoot))[0];
    } catch {
      // The server creates its spool lazily on the first probe call.
    }
    if (filename) break;
    await delay(5);
  }
  if (!filename) throw new Error("FabFilter MCP did not submit a probe command");
  const command = JSON.parse(await readFile(join(readyRoot, filename), "utf8")) as {
    readonly command_id: string;
    readonly operation: string;
    readonly payload: unknown;
  };
  assert.equal(command.operation, "fx.probe");
  assert.deepEqual(command.payload, { plugin: "Pro-Q 4 (FabFilter)", format: "VST3" });
  const receiptRoot = join(runtimeRoot, "bridge/main/receipts");
  await mkdir(join(receiptRoot, "tmp"), { recursive: true });
  await mkdir(join(receiptRoot, "ready"), { recursive: true });
  const receipt = {
    schema: "rma.bridge-receipt/v1",
    protocol_version: 1,
    command_id: command.command_id,
    status: "succeeded",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    artifacts: [],
    warnings: [],
    error: null,
    result: {
      plugin: "Pro-Q 4 (FabFilter)",
      format: "VST3",
      parameters: [
        { index: 0, name: "Bypass", ident: ":bypass", normalizedValue: 0, formattedValue: "Off" },
        { index: 1, name: "Band 1 Gain", ident: "vst3:1001", normalizedValue: 0.5, formattedValue: "0.0 dB" },
      ],
    },
  };
  const temporary = join(receiptRoot, "tmp", filename);
  await writeFile(temporary, JSON.stringify(receipt));
  await rename(temporary, join(receiptRoot, "ready", filename));
}

test("FabFilter MCP exposes recognized installations and profiled capabilities over stdio", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rma-fabfilter-mcp-"));
  const reaperResource = join(root, "REAPER");
  const configPath = join(root, "local.toml");
  const runtimeRoot = join(root, "runtime");
  await mkdir(reaperResource, { recursive: true });
  await writeFile(join(reaperResource, "reaper-vstplugins_arm64.ini"), [
    "[vstcache]",
    "FabFilter_Pro_Q_4.vst=failed",
    "FabFilter_Pro_Q_4.vst3=ABC,123{uid,Pro-Q 4 (FabFilter)",
    "FabFilter_Pro_C_2.vst3=ABC,124{uid,Pro-C 2 (FabFilter)",
    "",
  ].join("\n"));
  await writeFile(join(reaperResource, "reaper-clap-macos-aarch64.ini"), [
    "[FabFilter Pro-Q 4.clap]",
    "_=ABC",
    "com.fabfilter.pro-q.4=0|Pro-Q 4 (FabFilter)",
    "",
    "[FabFilter Saturn 2.clap]",
    "_=ABC",
    "com.fabfilter.saturn.2=0|Saturn 2 (FabFilter)",
    "",
  ].join("\n"));
  await writeFile(configPath, [
    "[paths]",
    `reaper_executable = ${JSON.stringify(join(root, "REAPER.app"))}`,
    `ffmpeg_executable = ${JSON.stringify(join(root, "ffmpeg"))}`,
    `reaper_resource_path = ${JSON.stringify(reaperResource)}`,
    `runtime_root = ${JSON.stringify(runtimeRoot)}`,
    `audio_work_root = ${JSON.stringify(join(root, "audio"))}`,
    "",
    "[network]",
    'daemon_host = "127.0.0.1"',
    "daemon_port = 32180",
    'dsh_host = "127.0.0.1"',
    "dsh_port = 3080",
    "",
    "[provider]",
    'base_url = "https://example.invalid/v1"',
    'model = "fixture"',
    'api_key_env = "FIXTURE_API_KEY"',
    "",
    "[reaper]",
    "poll_interval_ms = 10",
    "command_timeout_ms = 1000",
    "render_timeout_ms = 1000",
    "",
    "[safety]",
    "allow_network_audio_upload = false",
    "allow_source_media_write = false",
    "allow_gui_coordinate_control = false",
    "",
  ].join("\n"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import=tsx",
      join(process.cwd(), "src/mcp/fabfilter-server.ts"),
      "--config",
      configPath,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "fabfilter-contract", version: "1.0.0" });
  context.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["describe", "list_installed", "probe"]);

  const installedCall = await client.callTool({ name: "list_installed", arguments: {} });
  const installed = installedCall.structuredContent as unknown as InstalledResult;
  assert.equal(installed.schema, "rma.fabfilter-installed/v1");
  assert.deepEqual(installed.plugins, [
    {
      product: "Pro-C 2",
      formats: ["VST3"],
      preferredReaperName: "Pro-C 2 (FabFilter)",
      installations: [{
        format: "VST3",
        reaperCacheKey: "FabFilter_Pro_C_2.vst3",
        reaperName: "Pro-C 2 (FabFilter)",
      }],
      preferredInstallation: {
        format: "VST3",
        reaperCacheKey: "FabFilter_Pro_C_2.vst3",
        reaperName: "Pro-C 2 (FabFilter)",
      },
      automation: "profiled",
    },
    {
      product: "Pro-Q 4",
      formats: ["VST3", "CLAP"],
      preferredReaperName: "Pro-Q 4 (FabFilter)",
      installations: [
        {
          format: "VST3",
          reaperCacheKey: "FabFilter_Pro_Q_4.vst3",
          reaperName: "Pro-Q 4 (FabFilter)",
        },
        {
          format: "CLAP",
          reaperCacheKey: "FabFilter Pro-Q 4.clap",
          reaperName: "Pro-Q 4 (FabFilter)",
        },
      ],
      preferredInstallation: {
        format: "VST3",
        reaperCacheKey: "FabFilter_Pro_Q_4.vst3",
        reaperName: "Pro-Q 4 (FabFilter)",
      },
      automation: "profiled",
    },
    {
      product: "Saturn 2",
      formats: ["CLAP"],
      preferredReaperName: "Saturn 2 (FabFilter)",
      installations: [{
        format: "CLAP",
        reaperCacheKey: "FabFilter Saturn 2.clap",
        reaperName: "Saturn 2 (FabFilter)",
      }],
      preferredInstallation: {
        format: "CLAP",
        reaperCacheKey: "FabFilter Saturn 2.clap",
        reaperName: "Saturn 2 (FabFilter)",
      },
      automation: "inventory-only",
    },
  ]);

  const descriptionCall = await client.callTool({
    name: "describe",
    arguments: { product: "Pro-Q 4" },
  });
  const description = descriptionCall.structuredContent as unknown as DescriptionResult;
  assert.equal(description.schema, "rma.fabfilter-capability/v1");
  assert.equal(description.product, "Pro-Q 4");
  assert.equal(description.automation, "profiled");
  assert.deepEqual(description.semanticControls, ["air", "brightness", "high-pass", "resonance-control"]);

  const fakeBridge = answerProbeCommand(runtimeRoot);
  const probeCall = await client.callTool({ name: "probe", arguments: { product: "Pro-Q 4" } });
  await fakeBridge;
  assert.deepEqual(probeCall.structuredContent, {
    schema: "rma.fabfilter-probe/v1",
    product: "Pro-Q 4",
    reaperName: "Pro-Q 4 (FabFilter)",
    format: "VST3",
    parameters: [
      { index: 0, name: "Bypass", ident: ":bypass", normalizedValue: 0, formattedValue: "Off" },
      { index: 1, name: "Band 1 Gain", ident: "vst3:1001", normalizedValue: 0.5, formattedValue: "0.0 dB" },
    ],
  });
});
