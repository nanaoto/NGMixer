import { chmod, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { installBridge as installReaperBridge, type InstalledBridge } from "./bridge/install.js";
import { scanStudioInventory } from "./catalog/inventory.js";
import { runDoctor } from "./doctor.js";
import { bootstrapNapCatMacos } from "./qq/napcat-bootstrap.js";
import { loadRuntimeEnvironment } from "./runtime/environment.js";
import {
  setupLocalProject,
  type ProviderApi,
  type SetupModelSelection,
  type SetupProviderRoute,
} from "./setup.js";

export interface OnboardingProvider extends SetupProviderRoute {
  readonly apiKey: string;
}

export type OnboardingChannel =
  | { readonly kind: "web" }
  | {
    readonly kind: "qq";
    readonly accountId: string;
    readonly groupId: string;
    readonly groupIds: readonly string[];
    readonly privateUserIds: readonly string[];
  };

export interface InstallationRequest {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly environmentPath: string;
  readonly reaperExecutable: string;
  readonly ffmpegExecutable: string;
  readonly reaperResourcePath: string;
  readonly runtimeRoot: string;
  readonly audioWorkRoot: string;
  readonly modelConfiguration?: "dsh";
  readonly providers: readonly OnboardingProvider[];
  readonly defaultModel?: SetupModelSelection;
  readonly mixPlannerModel?: SetupModelSelection;
  readonly pluginRoots: readonly string[];
  readonly libraryRoots: readonly string[];
  readonly channel: OnboardingChannel;
}

export interface InstallationResult {
  readonly channel: OnboardingChannel["kind"];
  readonly webUi: true;
  readonly inventoryPath: string;
  readonly bridgeLauncherPath: string;
}

export interface InstallationDependencies {
  readonly installBridge?: (options: Parameters<typeof installReaperBridge>[0]) => Promise<InstalledBridge | {
    readonly launcherPath: string;
  }>;
  readonly configureQq?: (request: Extract<OnboardingChannel, { kind: "qq" }>, options: {
    readonly providerApiKeyEnvs: readonly string[];
    readonly environmentPath: string;
  }) => Promise<void>;
}

function environmentValue(value: string): string {
  if (value.includes("\0") || /[\r\n`$]/u.test(value)) {
    throw new Error("provider API key contains unsupported characters");
  }
  if (/^[A-Za-z0-9_./,:@+\-=]*$/u.test(value)) return value;
  return `'${value}'`;
}

async function writePrivateEnvironment(path: string, providers: readonly OnboardingProvider[]): Promise<void> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = current.split(/\r?\n/u).filter(Boolean);
  if (lines.length === 0) lines.push("# Private runtime credentials. chmod 600; never commit this file.");
  const credentials = new Map(providers.map((provider) => [provider.apiKeyEnv, provider.apiKey]));
  const written = new Set<string>();
  const updated = lines.map((line) => {
    if (line.trimStart().startsWith("#") || !line.includes("=")) return line;
    const name = line.slice(0, line.indexOf("=")).replace(/^export\s+/u, "").trim();
    const value = credentials.get(name);
    if (value === undefined) return line;
    written.add(name);
    return `${name}=${environmentValue(value)}`;
  });
  for (const [name, value] of credentials) {
    if (!written.has(name)) {
      updated.push(`${name}=${environmentValue(value)}`);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${process.pid}.runtime.env.tmp`);
  await writeFile(temporaryPath, `${updated.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

interface EnvironmentSnapshot {
  readonly existed: boolean;
  readonly contents: string;
}

async function captureEnvironment(path: string): Promise<EnvironmentSnapshot> {
  try {
    return { existed: true, contents: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false, contents: "" };
    throw error;
  }
}

async function restoreEnvironment(path: string, snapshot: EnvironmentSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await unlink(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${process.pid}.runtime.env.rollback.tmp`);
  await writeFile(temporaryPath, snapshot.contents, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

async function realExistingParent(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function assertPrivateEnvironmentLocation(projectRoot: string, environmentPath: string): Promise<void> {
  if (!isAbsolute(environmentPath)) throw new Error("runtime environment path must be absolute");
  const [realProjectRoot, realEnvironmentParent] = await Promise.all([
    realpath(resolve(projectRoot)),
    realExistingParent(dirname(resolve(environmentPath))),
  ]);
  const relation = relative(realProjectRoot, realEnvironmentParent);
  if (!relation.startsWith("..") && !isAbsolute(relation)) {
    throw new Error("runtime environment must not be stored inside the project repository");
  }
}

export async function initializeInstallation(
  request: InstallationRequest,
  dependencies: InstallationDependencies = {},
): Promise<InstallationResult> {
  await assertPrivateEnvironmentLocation(request.projectRoot, request.environmentPath);
  const environmentSnapshot = await captureEnvironment(request.environmentPath);
  const credentials = new Map<string, string>();
  for (const provider of request.providers) {
    if (!provider.apiKey) throw new Error("provider API key must not be empty");
    const existing = credentials.get(provider.apiKeyEnv);
    if (existing !== undefined && existing !== provider.apiKey) {
      throw new Error("providers sharing an API key environment variable must use the same credential");
    }
    credentials.set(provider.apiKeyEnv, provider.apiKey);
  }
  const providers = request.providers.map(({ apiKey: _apiKey, ...provider }) => provider);
  const setup = await setupLocalProject({
    configPath: request.configPath,
    providers,
    ...(request.modelConfiguration ? { modelConfiguration: request.modelConfiguration } : {}),
    ...(request.defaultModel ? { defaultModel: request.defaultModel } : {}),
    ...(request.mixPlannerModel ? { mixPlannerModel: request.mixPlannerModel } : {}),
    reaperExecutable: request.reaperExecutable,
    ffmpegExecutable: request.ffmpegExecutable,
    reaperResourcePath: request.reaperResourcePath,
    runtimeRoot: request.runtimeRoot,
    audioWorkRoot: request.audioWorkRoot,
  });
  try {
    await writePrivateEnvironment(request.environmentPath, request.providers);

    const inventory = await scanStudioInventory({
      reaperResourcePath: request.reaperResourcePath,
      pluginRoots: request.pluginRoots,
      libraryRoots: request.libraryRoots,
    });
    const inventoryPath = join(request.runtimeRoot, "catalog", "studio-inventory.json");
    await mkdir(dirname(inventoryPath), { recursive: true });
    await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(inventoryPath, 0o600);

    const installed = await (dependencies.installBridge ?? installReaperBridge)({
      reaperResourcePath: request.reaperResourcePath,
      runtimeRoot: request.runtimeRoot,
      audioWorkRoot: request.audioWorkRoot,
      bridgeInstanceId: "main",
      sourcePath: join(request.projectRoot, "reaper", "MixingAgentBridge.lua"),
      workerSourcePath: join(request.projectRoot, "reaper", "RenderWorker.lua"),
    });
    if (request.channel.kind === "qq") {
      const configureQq = dependencies.configureQq ?? (async (channel, options) => {
        await bootstrapNapCatMacos({
          projectRoot: request.projectRoot,
          accountId: channel.accountId,
          groupId: channel.groupId,
          groupIds: channel.groupIds,
          privateUserIds: channel.privateUserIds,
          providerApiKeyEnvs: options.providerApiKeyEnvs,
          eventPort: 32180,
          runtimeEnvironmentPath: options.environmentPath,
        });
      });
      await configureQq(request.channel, {
        providerApiKeyEnvs: setup.apiKeyEnvs,
        environmentPath: request.environmentPath,
      });
    }
    await loadRuntimeEnvironment(request.environmentPath);
    const doctor = await runDoctor(request.configPath);
    if (!doctor.ok) {
      throw new Error(`installation self-check failed:\n${doctor.lines.join("\n")}`);
    }
    const bridgeLauncherPath = "launcherPath" in installed
      ? installed.launcherPath
      : installed.launcherScriptPath;
    return {
      channel: request.channel.kind,
      webUi: true,
      inventoryPath,
      bridgeLauncherPath,
    };
  } catch (error) {
    await Promise.all([
      unlink(request.configPath).catch(() => undefined),
      restoreEnvironment(request.environmentPath, environmentSnapshot),
    ]);
    throw error;
  }
}

export type { ProviderApi };
