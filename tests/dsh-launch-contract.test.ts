import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { renderDshPatch } from "../src/dsh/launch.js";

const executeFile = promisify(execFile);

async function waitForOutput(read: () => string, pattern: RegExp, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(read())) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${pattern}:\n${read()}`);
}

function hmrContractPlugin(
  generation: 1 | 2 | 3,
  mixingPluginUrl: string,
  releasePath: string,
): string {
  return [
    'import { access } from "node:fs/promises";',
    'import { setTimeout as delay } from "node:timers/promises";',
    `import { createReloadableMixingRuntime } from ${JSON.stringify(mixingPluginUrl)};`,
    `console.log("HMR_GEN_${generation}_LOADED");`,
    'export const name = "rma-hmr-contract";',
    'export function apply() {',
    `  console.log("HMR_GEN_${generation}_APPLY");`,
    '  const runtime = createReloadableMixingRuntime(async () => ({',
    '    run: async () => { throw new Error("not used"); },',
    '    recordDelivery: async () => {',
    `      console.log("HMR_GEN_${generation}_START");`,
    ...(generation === 1 ? [
      '      while (true) {',
      `        try { await access(${JSON.stringify(releasePath)}); break; } catch { await delay(10); }`,
      '      }',
      '      console.log("HMR_GEN_1_END");',
    ] : [
      '      setImmediate(() => process.exit(0));',
    ]),
    '    },',
    '  }));',
    ...(generation === 2 ? [] : [
      '  void runtime.recordDelivery({',
      '    sessionId: "hmr-contract", sourceEventId: "source-1", iteration: 1,',
      '    deliveryId: "delivery-1", status: "delivered",',
      `  }).catch((error) => console.error("HMR_GEN_${generation}_ERROR", error.code, error.message));`,
    ]),
    '  return () => runtime.drain();',
    '}',
    '',
  ].join("\n");
}

test("installed DSH boots the TypeScript mixing plugin directly without provider network", async (context) => {
  const projectRoot = process.cwd();
  await mkdir(join(projectRoot, "var"), { recursive: true });
  const dshHome = await mkdtemp(join(projectRoot, "var/dsh-contract-"));
  context.after(async () => rm(dshHome, { recursive: true, force: true }));
  const pluginPath = join(projectRoot, "src/dsh/mixing-plugin.ts");
  const patchPath = join(dshHome, "contract.patch.yml");
  await writeFile(patchPath, renderDshPatch({
    pluginPath,
    configPath: join(dshHome, "unused.toml"),
    bridgeInstanceId: "contract",
    llm: {
      default: { provider: "contract-route", model: "contract-model" },
      mixPlanner: { provider: "contract-route", model: "contract-model" },
      providers: {
        "contract-route": {
          api: "openai-completions",
          baseUrl: "https://network-must-not-run.invalid/v1",
          apiKeyEnv: "RMA_CONTRACT_API_KEY",
          models: [{ id: "contract-model" }],
        },
      },
    },
  }));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=tsx"].filter(Boolean).join(" "),
  };
  delete environment.RMA_CONTRACT_API_KEY;

  let output = "";
  try {
    const result = await executeFile(join(projectRoot, "node_modules/.bin/dsh"), [
      "--profile", "headless", "--patch", patchPath, "contract-smoke",
    ], { cwd: projectRoot, env: environment, timeout: 10_000 });
    output = `${result.stdout}${result.stderr}`;
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }

  assert.match(output, /MISSING_CREDENTIAL[\s\S]*provider route "contract-route"/u);
  assert.doesNotMatch(
    output,
    /NO_ADAPTER|duplicate loader entry|ERR_UNKNOWN_FILE_EXTENSION|ERR_MODULE_NOT_FOUND/u,
  );
});

test("installed DSH registers the TypeScript studio, FabFilter, and REAPER Docs MCP tools", async (context) => {
  const projectRoot = process.cwd();
  await mkdir(join(projectRoot, "var"), { recursive: true });
  const directory = await mkdtemp(join(projectRoot, "var/dsh-fabfilter-mcp-contract-"));
  const dshHome = join(directory, "home");
  const inspectorPath = join(directory, "inspect-tools.mjs");
  const patchPath = join(directory, "contract.patch.yml");
  context.after(async () => rm(directory, { recursive: true, force: true }));
  await writeFile(inspectorPath, [
    'import { setTimeout as delay } from "node:timers/promises";',
    'export const name = "inspect-rma-mcp-tools";',
    'export const inject = ["tools"];',
    'export async function apply(context) {',
    '  let fabFilterNames = [];',
    '  let reaperDocsNames = [];',
    '  let studioInventoryNames = [];',
    '  for (let attempt = 0; attempt < 250; attempt += 1) {',
    '    const names = [...context.tools.view().visible.keys()];',
    '    fabFilterNames = names.filter((name) => name.startsWith("mcp__fabfilter__")).sort();',
    '    reaperDocsNames = names.filter((name) => name.startsWith("mcp__reaper_docs__")).sort();',
    '    studioInventoryNames = names.filter((name) => name.startsWith("mcp__studio_inventory__")).sort();',
    '    if (fabFilterNames.length === 3 && reaperDocsNames.length === 4 && studioInventoryNames.length === 2) break;',
    '    await delay(20);',
    '  }',
    '  console.log(`FABFILTER_MCP_TOOLS=${fabFilterNames.join(",")}`);',
    '  console.log(`REAPER_DOCS_MCP_TOOLS=${reaperDocsNames.join(",")}`);',
    '  console.log(`STUDIO_INVENTORY_MCP_TOOLS=${studioInventoryNames.join(",")}`);',
    '  setImmediate(() => process.exit(0));',
    '}',
    '',
  ].join("\n"));
  await writeFile(patchPath, [
    "- insert:",
    "    - id: mcp-fabfilter-contract",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    '        serverName: "fabfilter"',
    '        transport: "stdio"',
    `        command: ${JSON.stringify(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${JSON.stringify(join(projectRoot, "src/mcp/fabfilter-server.ts"))}`,
    '          - "--config"',
    `          - ${JSON.stringify(join(directory, "unused.toml"))}`,
    `        cwd: ${JSON.stringify(projectRoot)}`,
    "        failOnStartupError: true",
    "- insert:",
    "    - id: mcp-studio-inventory-contract",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    '        serverName: "studio_inventory"',
    '        transport: "stdio"',
    `        command: ${JSON.stringify(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${JSON.stringify(join(projectRoot, "src/mcp/studio-inventory-server.ts"))}`,
    '          - "--inventory"',
    `          - ${JSON.stringify(join(directory, "unused-inventory.json"))}`,
    `        cwd: ${JSON.stringify(projectRoot)}`,
    "        failOnStartupError: true",
    "- insert:",
    "    - id: mcp-reaper-docs-contract",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    '        serverName: "reaper_docs"',
    '        transport: "stdio"',
    `        command: ${JSON.stringify(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${JSON.stringify(join(projectRoot, "src/mcp/reaper-docs-server.ts"))}`,
    '          - "--config"',
    `          - ${JSON.stringify(join(directory, "unused.toml"))}`,
    `        cwd: ${JSON.stringify(projectRoot)}`,
    "        failOnStartupError: true",
    "- insert:",
    "    - id: inspect-fabfilter-tools",
    `      name: ${JSON.stringify(inspectorPath)}`,
    "",
  ].join("\n"));

  const result = await executeFile(join(projectRoot, "node_modules/.bin/dsh"), [
    "--profile", "web", "--patch", patchPath, "--no-open", "--port", "0",
  ], {
    cwd: projectRoot,
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 10_000,
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.match(
    output,
    /FABFILTER_MCP_TOOLS=mcp__fabfilter__describe,mcp__fabfilter__list_installed,mcp__fabfilter__probe/u,
  );
  assert.match(
    output,
    /REAPER_DOCS_MCP_TOOLS=mcp__reaper_docs__describe_api,mcp__reaper_docs__refresh,mcp__reaper_docs__search,mcp__reaper_docs__status/u,
  );
  assert.match(
    output,
    /STUDIO_INVENTORY_MCP_TOOLS=mcp__studio_inventory__search_plugins,mcp__studio_inventory__status/u,
  );
  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|UNKNOWN_TOOL|startup failed/u);
});

test("Cordis HMR keeps rapid mixing generations behind the original drain barrier", async (context) => {
  const projectRoot = process.cwd();
  await mkdir(join(projectRoot, "var"), { recursive: true });
  const directory = await mkdtemp(join(projectRoot, "var/dsh-hmr-contract-"));
  const pluginDirectory = join(directory, "src/dsh");
  const pluginPath = join(pluginDirectory, "contract-plugin.ts");
  const patchPath = join(directory, "contract.patch.yml");
  const releasePath = join(directory, "release-first-generation");
  const dshHome = join(directory, "home");
  const mixingPluginUrl = pathToFileURL(join(projectRoot, "src/dsh/mixing-plugin.ts")).href;
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(pluginPath, hmrContractPlugin(1, mixingPluginUrl, releasePath));
  await writeFile(patchPath, renderDshPatch({
    pluginPath,
    configPath: join(directory, "unused.toml"),
    bridgeInstanceId: "hmr-contract",
  }));

  const child = spawn(join(projectRoot, "node_modules/.bin/dsh"), [
    "web", "--patch", patchPath, "--no-open", "--port", "0",
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=tsx"].filter(Boolean).join(" "),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  context.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  });

  await waitForOutput(() => output, /HMR_GEN_1_START/u);
  await writeFile(pluginPath, hmrContractPlugin(2, mixingPluginUrl, releasePath));
  await waitForOutput(() => output, /HMR_GEN_2_APPLY/u);
  await delay(100);
  await writeFile(pluginPath, hmrContractPlugin(3, mixingPluginUrl, releasePath));
  await waitForOutput(() => output, /HMR_GEN_3_APPLY/u);
  await delay(100);
  assert.doesNotMatch(output, /HMR_GEN_[23]_START/u);

  await writeFile(releasePath, "release\n");
  await waitForOutput(() => output, /HMR_GEN_1_END[\s\S]*HMR_GEN_3_START/u);
});

test("installed DSH gives a trusted QQ agent bash, REAPER MCPs, and full access", async (context) => {
  const projectRoot = process.cwd();
  await mkdir(join(projectRoot, "var"), { recursive: true });
  const dshHome = await mkdtemp(join(projectRoot, "var/dsh-qq-tools-contract-"));
  context.after(async () => rm(dshHome, { recursive: true, force: true }));
  const pluginPath = join(dshHome, "qq-tools-contract.mjs");
  const patchPath = join(dshHome, "qq-tools-contract.patch.yml");
  const qqPluginUrl = pathToFileURL(join(projectRoot, "src/plugins/qq-agent-plugin.ts")).href;
  await writeFile(pluginPath, [
    'import "tsx/esm";',
    'import { setTimeout as delay } from "node:timers/promises";',
    'import { assembleContextFor } from "@deepseek-ai/dsh-agent";',
    `const { configureQqAgentPermissions, configureQqAgentToolScope, qqAgentPreset } = await import(${JSON.stringify(qqPluginUrl)});`,
    'export const name = "qq-tools-contract";',
    'export const inject = ["agents", "agentPresets", "permissionPresets", "tools"];',
    'export async function apply(context) {',
    '  const requiredMcpTools = ["mcp__fabfilter__describe", "mcp__reaper_docs__describe_api"];',
    '  for (let attempt = 0; attempt < 250; attempt += 1) {',
    '    const visible = context.tools.view().visible;',
    '    if (requiredMcpTools.every((name) => visible.has(name))) break;',
    '    if (attempt === 249) throw new Error("QQ contract timed out waiting for REAPER MCP tools");',
    '    await delay(20);',
    '  }',
    '  const handle = await context.agents.create({',
    '    sessionId: "qq-tools-contract",',
    '    meta: { cwd: process.cwd(), agentPreset: qqAgentPreset },',
    '    setup: async (agentContext) => {',
    '      await configureQqAgentToolScope(context, agentContext, "trusted-private");',
    '      configureQqAgentPermissions(context, agentContext, "trusted-private");',
    '    },',
    '  });',
    '  const assembly = await handle.agent.ctx.systemPrompt.assemble(assembleContextFor(handle.agent));',
    '  const names = assembly.tools.map((schema) => schema.name).sort();',
    '  console.log(`QQ_TRUSTED_TOOLS=${names.join(",")}`);',
    '  console.log(`QQ_TRUSTED_PERMISSION=${context.permissionPresets.current(handle.agent.session.events)}`);',
    '  configureQqAgentPermissions(context, handle.agent.ctx, "restricted");',
    '  console.log(`QQ_DOWNGRADED_PERMISSION=${context.permissionPresets.current(handle.agent.session.events)}`);',
    '  await handle.dispose();',
    '  setImmediate(() => process.exit(0));',
    '}',
    "",
  ].join("\n"));
  await writeFile(patchPath, [
    "- insert:",
    "    - id: mcp-fabfilter-qq-contract",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    '        serverName: "fabfilter"',
    '        transport: "stdio"',
    `        command: ${JSON.stringify(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${JSON.stringify(join(projectRoot, "src/mcp/fabfilter-server.ts"))}`,
    '          - "--config"',
    `          - ${JSON.stringify(join(dshHome, "unused.toml"))}`,
    `        cwd: ${JSON.stringify(projectRoot)}`,
    "        failOnStartupError: true",
    "- insert:",
    "    - id: mcp-reaper-docs-qq-contract",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    '        serverName: "reaper_docs"',
    '        transport: "stdio"',
    `        command: ${JSON.stringify(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${JSON.stringify(join(projectRoot, "src/mcp/reaper-docs-server.ts"))}`,
    '          - "--config"',
    `          - ${JSON.stringify(join(dshHome, "unused.toml"))}`,
    `        cwd: ${JSON.stringify(projectRoot)}`,
    "        failOnStartupError: true",
    "- insert:",
    "    - id: qq-tools-contract",
    `      name: ${JSON.stringify(pluginPath)}`,
    "",
  ].join("\n"));

  const result = await executeFile(join(projectRoot, "node_modules/.bin/dsh"), [
    "--profile", "web", "--patch", patchPath, "--no-open", "--port", "0",
  ], {
    cwd: projectRoot,
    env: { ...process.env, DSH_HOME: dshHome },
    timeout: 10_000,
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bbash\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__fabfilter__describe\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__fabfilter__list_installed\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__fabfilter__probe\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__reaper_docs__describe_api\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__reaper_docs__refresh\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__reaper_docs__search\b/u);
  assert.match(output, /QQ_TRUSTED_TOOLS=[^\n]*\bmcp__reaper_docs__status\b/u);
  assert.match(output, /QQ_TRUSTED_PERMISSION=danger-full-access/u);
  assert.match(output, /QQ_DOWNGRADED_PERMISSION=workspace-write/u);
  assert.doesNotMatch(output, /preset .* failed to mount|UNKNOWN_TOOL/u);
});
