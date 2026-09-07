import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

import { loadConfig, type LocalConfig } from "../config.js";
import { loadRuntimeEnvironment } from "../runtime/environment.js";

export interface DshPatchOptions {
  readonly pluginPath: string;
  readonly modelFailoverPluginPath?: string;
  readonly fabFilterMcpServerPath?: string;
  readonly reaperDocsMcpServerPath?: string;
  readonly studioInventoryMcpServerPath?: string;
  readonly studioInventoryPath?: string;
  readonly configPath: string;
  readonly bridgeInstanceId: string;
  readonly llm?: LocalConfig["llm"];
  readonly qq?: {
    readonly transportPluginPath: string;
    readonly agentPluginPath: string;
    readonly napCatUrl: string;
    readonly outboundStagingRoot: string;
    readonly tokenEnv: string;
    readonly accountId: string;
    readonly groupId: string;
    readonly groupIds?: readonly string[];
    readonly privateUserIds?: readonly string[];
  };
}

export interface PreparedDshLaunch {
  readonly dshHome: string;
  readonly patchPath: string;
}

export interface DshLaunchInvocation {
  readonly profile: "web" | "headless";
  readonly args: readonly string[];
}

export function parseDshLaunchInvocation(argv: readonly string[]): DshLaunchInvocation {
  return argv[0] === "--headless"
    ? { profile: "headless", args: argv.slice(1) }
    : { profile: "web", args: argv };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function failoverPools(llm: NonNullable<LocalConfig["llm"]>): readonly (readonly {
  readonly provider: string;
  readonly model: string;
}[])[] {
  if (!llm.default.fallbacks?.length) return [];
  return [[
    { provider: llm.default.provider, model: llm.default.model },
    ...llm.default.fallbacks,
  ]];
}

function appendStdioMcp(
  lines: string[],
  options: DshPatchOptions,
  id: string,
  serverName: string,
  serverPath: string,
): void {
  const projectRoot = dirname(dirname(dirname(serverPath)));
  lines.push(
    "- insert:",
    `    - id: ${id}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    `        serverName: ${yamlString(serverName)}`,
    '        transport: "stdio"',
    `        command: ${yamlString(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${yamlString(serverPath)}`,
    '          - "--config"',
    `          - ${yamlString(options.configPath)}`,
    '          - "--bridge-instance"',
    `          - ${yamlString(options.bridgeInstanceId)}`,
    `        cwd: ${yamlString(projectRoot)}`,
    "        failOnStartupError: true",
    "        reconnect:",
    "          enabled: true",
    "",
  );
}

function appendStudioInventoryMcp(
  lines: string[],
  serverPath: string,
  inventoryPath: string,
): void {
  const projectRoot = dirname(dirname(dirname(serverPath)));
  lines.push(
    "- insert:",
    "    - id: mcp-studio-inventory",
    '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config:",
    '        serverName: "studio_inventory"',
    '        transport: "stdio"',
    `        command: ${yamlString(process.execPath)}`,
    "        args:",
    '          - "--import=tsx"',
    `          - ${yamlString(serverPath)}`,
    '          - "--inventory"',
    `          - ${yamlString(inventoryPath)}`,
    `        cwd: ${yamlString(projectRoot)}`,
    "        failOnStartupError: true",
    "        reconnect:",
    "          enabled: true",
    "",
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : undefined;
}

async function assertPersistedModelSelectionCompatible(
  settingsPath: string,
  llm: NonNullable<LocalConfig["llm"]>,
): Promise<void> {
  let source: string;
  try {
    source = await readFile(settingsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new Error(`${settingsPath} is not valid YAML; refusing DSH launch`);
  }
  const root = record(document.toJS() ?? {});
  if (!root) throw new Error(`${settingsPath} must contain a settings map`);
  const saved = root["agent-default-model"];
  if (saved === undefined) return;
  const selection = record(saved);
  const provider = selection?.provider;
  const model = selection?.model;
  if (typeof provider !== "string" || typeof model !== "string") {
    throw new Error(`${settingsPath} has an invalid agent-default-model selection`);
  }
  const route = llm.providers[provider];
  if (!route || !route.models.some((candidate) => candidate.id === model)) {
    throw new Error(
      `${settingsPath} selects unavailable model route ${provider}/${model}; update or remove its agent-default-model section before DSH launch`,
    );
  }
}

export function renderDshPatch(options: DshPatchOptions): string {
  const lines: string[] = [
    "- id: hmr",
    "  disabled: false",
    "  config:",
    "    root:",
    `      - ${yamlString(dirname(dirname(options.pluginPath)))}`,
    "",
  ];
  if (options.llm) {
    const pools = failoverPools(options.llm);
    lines.push(
      "- id: llm-deepseek",
      "  disabled: true",
      "- id: llm-pi-ai",
      "  config:",
      "    providers:",
    );
    for (const [routeName, provider] of Object.entries(options.llm.providers)) {
      lines.push(
        `      ${yamlString(routeName)}:`,
        ...(provider.displayName === undefined
          ? []
          : [`        displayName: ${yamlString(provider.displayName)}`]),
        `        apiKeyEnv: ${yamlString(provider.apiKeyEnv)}`,
        `        api: ${yamlString(provider.api)}`,
        `        baseURL: ${yamlString(provider.baseUrl)}`,
        "        models:",
      );
      for (const model of provider.models) {
        lines.push(
          `          - id: ${yamlString(model.id)}`,
          ...(model.name === undefined ? [] : [`            name: ${yamlString(model.name)}`]),
          ...(model.contextWindow === undefined
            ? []
            : [`            contextWindow: ${model.contextWindow}`]),
          ...(model.maxTokens === undefined ? [] : [`            maxTokens: ${model.maxTokens}`]),
        );
      }
    }
    lines.push(
      "",
      "- id: agent-default-model",
      "  config:",
      `    provider: ${yamlString(options.llm.default.provider)}`,
      `    model: ${yamlString(options.llm.default.model)}`,
      "",
    );
    if (pools.length > 0) {
      if (!options.modelFailoverPluginPath) {
        throw new Error("modelFailoverPluginPath is required when an LLM selection has fallbacks");
      }
      lines.push(
        "- insert:",
        "    - id: model-failover",
        `      name: ${yamlString(options.modelFailoverPluginPath)}`,
        "      config:",
        "        pools:",
      );
      for (const routes of pools) {
        lines.push("          - routes:");
        for (const route of routes) {
          lines.push(
            `              - provider: ${yamlString(route.provider)}`,
            `                model: ${yamlString(route.model)}`,
          );
        }
      }
      lines.push("");
    }
  }
  lines.push(
    "- insert:",
    "    - id: computer-use",
    '      name: "@anionex/dsh-computer-use"',
    "      config:",
    "        observationTtlMs: 10000",
    "        interaction:",
    "          focusPolicy: preserve",
    "          keyboardPolicy: activate",
    "          pointerInputPolicy: targeted",
    "          cursorVisualization: visible",
    "          cursorAutoHideMs: 0",
    "        allowAllApps: false",
    "        grants:",
    "          - bundleId: com.cockos.reaper",
    "            read: true",
    "            control: true",
    "",
  );
  if (options.fabFilterMcpServerPath) {
    appendStdioMcp(lines, options, "mcp-fabfilter", "fabfilter", options.fabFilterMcpServerPath);
  }
  if (options.reaperDocsMcpServerPath) {
    appendStdioMcp(
      lines,
      options,
      "mcp-reaper-docs",
      "reaper_docs",
      options.reaperDocsMcpServerPath,
    );
  }
  if (options.studioInventoryMcpServerPath && options.studioInventoryPath) {
    appendStudioInventoryMcp(
      lines,
      options.studioInventoryMcpServerPath,
      options.studioInventoryPath,
    );
  }
  lines.push(
    "- insert:",
    "    - id: reaper-mixing-agent",
    `      name: ${yamlString(options.pluginPath)}`,
    "      config:",
    `        configPath: ${yamlString(options.configPath)}`,
    `        bridgeInstanceId: ${yamlString(options.bridgeInstanceId)}`,
    ...(options.llm === undefined ? [] : [
      `        plannerProvider: ${yamlString(options.llm.mixPlanner.provider)}`,
      `        plannerModel: ${yamlString(options.llm.mixPlanner.model)}`,
      ...(options.llm.mixPlanner.fallbacks?.length ? [
        "        plannerFallbacks:",
        ...options.llm.mixPlanner.fallbacks.flatMap((route) => [
          `          - provider: ${yamlString(route.provider)}`,
          `            model: ${yamlString(route.model)}`,
        ]),
      ] : []),
    ]),
    "",
  );
  if (options.qq) {
    lines.push(
      "- insert:",
      "    - id: qq-transport",
      `      name: ${yamlString(options.qq.transportPluginPath)}`,
      "      config:",
      `        configPath: ${yamlString(options.configPath)}`,
      `        napCatUrl: ${yamlString(options.qq.napCatUrl)}`,
      `        outboundStagingRoot: ${yamlString(options.qq.outboundStagingRoot)}`,
      `        tokenEnv: ${yamlString(options.qq.tokenEnv)}`,
      `        accountId: ${yamlString(options.qq.accountId)}`,
      `        groupId: ${yamlString(options.qq.groupId)}`,
    );
    if (options.qq.groupIds?.length) {
      lines.push("        groupIds:", ...options.qq.groupIds.map((id) => `          - ${yamlString(id)}`));
    }
    if (options.qq.privateUserIds?.length) {
      lines.push(
        "        privateUserIds:",
        ...options.qq.privateUserIds.map((id) => `          - ${yamlString(id)}`),
      );
    }
    lines.push(
      "",
      "- insert:",
      "    - id: qq-agent",
      `      name: ${yamlString(options.qq.agentPluginPath)}`,
      "      config:",
      `        configPath: ${yamlString(options.configPath)}`,
      `        accountId: ${yamlString(options.qq.accountId)}`,
      `        defaultGroupId: ${yamlString(options.qq.groupId)}`,
    );
    if (options.qq.groupIds?.length) {
      lines.push("        groupIds:", ...options.qq.groupIds.map((id) => `          - ${yamlString(id)}`));
    }
    if (options.qq.privateUserIds?.length) {
      lines.push(
        "        trustedPrivateUserIds:",
        ...options.qq.privateUserIds.map((id) => `          - ${yamlString(id)}`),
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function prepareDshLaunch(
  projectRoot: string,
  options: {
    readonly bridgeInstanceId?: string;
    readonly configPath?: string;
    readonly llm?: DshPatchOptions["llm"];
    readonly studioInventoryPath?: string;
    readonly qq?: DshPatchOptions["qq"] | false;
  } = {},
): Promise<PreparedDshLaunch> {
  const dshRoot = join(projectRoot, "var", "dsh");
  const dshHome = join(dshRoot, "home");
  const patchPath = join(dshRoot, "mixing.patch.yml");
  const qq = options.qq === false ? undefined : options.qq ?? qqOptionsFromEnvironment(projectRoot);
  if (options.llm) {
    await assertPersistedModelSelectionCompatible(join(dshHome, "settings.yaml"), options.llm);
  }
  await mkdir(dshHome, { recursive: true });
  await writeFile(
    patchPath,
    renderDshPatch({
      pluginPath: join(projectRoot, "src", "dsh", "mixing-plugin.ts"),
      modelFailoverPluginPath: join(projectRoot, "src", "dsh", "model-failover-plugin.ts"),
      fabFilterMcpServerPath: join(projectRoot, "src", "mcp", "fabfilter-server.ts"),
      reaperDocsMcpServerPath: join(projectRoot, "src", "mcp", "reaper-docs-server.ts"),
      studioInventoryMcpServerPath: join(projectRoot, "src", "mcp", "studio-inventory-server.ts"),
      ...(options.studioInventoryPath ? { studioInventoryPath: options.studioInventoryPath } : {}),
      configPath: options.configPath ?? join(projectRoot, "config", "local.toml"),
      bridgeInstanceId: options.bridgeInstanceId ?? "main",
      ...(options.llm ? { llm: options.llm } : {}),
      ...(qq ? { qq } : {}),
    }),
    "utf8",
  );
  return { dshHome, patchPath };
}

function commaSeparated(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

export function qqOptionsFromEnvironment(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): NonNullable<DshPatchOptions["qq"]> | undefined {
  const values = {
    napCatUrl: environment.RMA_NAPCAT_URL,
    tokenEnv: environment.RMA_NAPCAT_TOKEN_ENV,
    accountId: environment.RMA_QQ_ACCOUNT_ID,
    groupId: environment.RMA_QQ_GROUP_ID,
    outboundStagingRoot: environment.RMA_QQ_OUTBOUND_STAGING_ROOT,
  };
  const present = Object.values(values).filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (present !== Object.keys(values).length) {
    throw new Error("QQ DSH launch requires RMA_NAPCAT_URL, RMA_NAPCAT_TOKEN_ENV, RMA_QQ_ACCOUNT_ID, RMA_QQ_GROUP_ID, and RMA_QQ_OUTBOUND_STAGING_ROOT together");
  }
  const groupIds = commaSeparated(environment.RMA_QQ_GROUP_IDS);
  const privateUserIds = commaSeparated(environment.RMA_QQ_PRIVATE_USER_IDS);
  return {
    transportPluginPath: join(projectRoot, "src", "plugins", "qq-transport-plugin.ts"),
    agentPluginPath: join(projectRoot, "src", "plugins", "qq-agent-plugin.ts"),
    napCatUrl: values.napCatUrl!,
    tokenEnv: values.tokenEnv!,
    accountId: values.accountId!,
    groupId: values.groupId!,
    outboundStagingRoot: values.outboundStagingRoot!,
    ...(groupIds ? { groupIds } : {}),
    ...(privateUserIds ? { privateUserIds } : {}),
  };
}

async function main(): Promise<number> {
  const projectRoot = process.cwd();
  const invocation = parseDshLaunchInvocation(process.argv.slice(2));
  await loadRuntimeEnvironment(
    process.env.RMA_ENV_FILE ?? join(homedir(), ".config/reaper-mixing-agent/runtime.env"),
  );
  const configPath = process.env.RMA_CONFIG_PATH ?? join(projectRoot, "config", "local.toml");
  const config = await loadConfig(configPath);
  const prepared = await prepareDshLaunch(projectRoot, {
    ...(process.env.RMA_BRIDGE_INSTANCE === undefined
      ? {}
      : { bridgeInstanceId: process.env.RMA_BRIDGE_INSTANCE }),
    configPath,
    ...(config.llm ? { llm: config.llm } : {}),
    studioInventoryPath: join(config.paths.runtimeRoot, "catalog", "studio-inventory.json"),
    ...(invocation.profile === "headless" ? { qq: false } : {}),
  });
  const executable = join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "dsh.cmd" : "dsh",
  );
  const profileArgs = invocation.profile === "web" ? ["web"] : ["--profile", "headless"];
  const child = spawn(executable, [...profileArgs, "--patch", prepared.patchPath, ...invocation.args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DSH_HOME: prepared.dshHome,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=tsx"].filter(Boolean).join(" "),
    },
    stdio: "inherit",
  });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  process.exitCode = await main();
}
