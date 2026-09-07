import { constants } from "node:fs";
import { access, chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface SetupProviderRoute {
  readonly route: string;
  readonly displayName?: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly models: readonly string[];
}

export interface SetupModelSelection {
  readonly provider: string;
  readonly model: string;
}

export interface SetupLocalProjectOptions {
  readonly configPath: string;
  readonly modelConfiguration?: "dsh";
  readonly baseUrl?: string;
  readonly model?: string;
  readonly apiKeyEnv?: string;
  readonly provider?: string;
  readonly providerApi?: ProviderApi;
  readonly providers?: readonly SetupProviderRoute[];
  readonly defaultModel?: SetupModelSelection;
  readonly mixPlannerModel?: SetupModelSelection;
  readonly reaperExecutable?: string;
  readonly ffmpegExecutable?: string;
  readonly reaperResourcePath?: string;
  readonly runtimeRoot?: string;
  readonly audioWorkRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
}

export interface SetupLocalProjectReport {
  readonly configPath: string;
  readonly runtimeRoot: string;
  readonly audioWorkRoot: string;
  readonly apiKeyEnvs: readonly string[];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function absoluteMachinePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return resolve(value);
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function directory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function pathCandidates(environment: NodeJS.ProcessEnv, executableName: string): string[] {
  return (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directoryPath) => join(directoryPath, executableName));
}

function renderLocalConfig(options: {
  readonly reaperExecutable: string;
  readonly ffmpegExecutable: string;
  readonly reaperResourcePath: string;
  readonly runtimeRoot: string;
  readonly audioWorkRoot: string;
  readonly providers: readonly SetupProviderRoute[];
  readonly defaultModel?: SetupModelSelection;
  readonly mixPlannerModel?: SetupModelSelection;
}): string {
  return [
    "[paths]",
    `reaper_executable = ${tomlString(options.reaperExecutable)}`,
    `ffmpeg_executable = ${tomlString(options.ffmpegExecutable)}`,
    `reaper_resource_path = ${tomlString(options.reaperResourcePath)}`,
    `runtime_root = ${tomlString(options.runtimeRoot)}`,
    `audio_work_root = ${tomlString(options.audioWorkRoot)}`,
    "",
    "[network]",
    'daemon_host = "127.0.0.1"',
    "daemon_port = 32180",
    'dsh_host = "127.0.0.1"',
    "dsh_port = 3080",
    "",
    ...(options.defaultModel && options.mixPlannerModel ? [
      "[llm.default]",
      `provider = ${tomlString(options.defaultModel.provider)}`,
      `model = ${tomlString(options.defaultModel.model)}`,
      "",
      "[llm.mix_planner]",
      `provider = ${tomlString(options.mixPlannerModel.provider)}`,
      `model = ${tomlString(options.mixPlannerModel.model)}`,
      "",
    ] : []),
    ...options.providers.flatMap((provider) => [
      `[llm.providers.${tomlString(provider.route)}]`,
      ...(provider.displayName ? [`display_name = ${tomlString(provider.displayName)}`] : []),
      `api = ${tomlString(provider.api)}`,
      `base_url = ${tomlString(provider.baseUrl)}`,
      `api_key_env = ${tomlString(provider.apiKeyEnv)}`,
      "",
      ...provider.models.flatMap((model) => [
        `[[llm.providers.${tomlString(provider.route)}.models]]`,
        `id = ${tomlString(model)}`,
        "",
      ]),
    ]),
    "[reaper]",
    "poll_interval_ms = 100",
    "command_timeout_ms = 30000",
    "render_timeout_ms = 300000",
    "",
    "[safety]",
    "allow_network_audio_upload = false",
    "allow_source_media_write = false",
    "allow_gui_coordinate_control = false",
    "",
  ].join("\n");
}

export async function setupLocalProject(
  options: SetupLocalProjectOptions,
): Promise<SetupLocalProjectReport> {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const configPath = resolve(options.configPath);

  try {
    await access(configPath);
    throw new Error(`config already exists at ${configPath}; refusing to overwrite it`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const providers = options.modelConfiguration === "dsh" ? [] : options.providers ?? [{
    route: options.provider ?? "primary",
    displayName: "Local Setup Provider",
    api: options.providerApi ?? "openai-completions",
    baseUrl: options.baseUrl ?? "",
    apiKeyEnv: options.apiKeyEnv ?? "REAPER_MIXING_AGENT_API_KEY",
    models: [options.model ?? ""],
  }];
  if (providers.length === 0 && options.modelConfiguration !== "dsh") throw new Error("configure at least one provider route");
  for (const provider of providers) {
    let providerUrl: URL;
    try {
      providerUrl = new URL(provider.baseUrl);
    } catch {
      throw new Error("provider base URL is invalid");
    }
    if (!/^https?:$/u.test(providerUrl.protocol)) {
      throw new Error("provider base URL must use http or https");
    }
    if (providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash) {
      throw new Error("provider base URL must not include credentials, query parameters, or fragments");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(provider.apiKeyEnv)) {
      throw new Error("provider API key environment variable name is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider.route)) {
      throw new Error("provider route name is invalid");
    }
    if (provider.models.length === 0 || provider.models.some((model) => !model.trim())) {
      throw new Error("provider model must not be empty");
    }
  }
  if (new Set(providers.map((provider) => provider.route)).size !== providers.length) {
    throw new Error("provider route names must be unique");
  }
  const defaultModel = options.modelConfiguration === "dsh" ? undefined : options.defaultModel ?? {
    provider: providers[0]!.route,
    model: providers[0]!.models[0]!,
  };
  const mixPlannerModel = options.mixPlannerModel ?? defaultModel;
  for (const selection of [defaultModel, mixPlannerModel]) {
    if (!selection) continue;
    const route = providers.find((provider) => provider.route === selection.provider);
    if (!route?.models.includes(selection.model)) {
      throw new Error("model selection must reference a configured provider model");
    }
  }

  const detectedReaper = options.reaperExecutable ?? (platform === "darwin"
    ? await firstExecutable([
      "/Applications/REAPER.app/Contents/MacOS/REAPER",
      "/Applications/REAPER64.app/Contents/MacOS/REAPER",
    ])
    : undefined);
  if (!detectedReaper) {
    throw new Error("REAPER executable was not detected; pass --reaper-executable with an absolute path");
  }
  const reaperExecutable = absoluteMachinePath(detectedReaper, "REAPER executable");
  if (!await executable(reaperExecutable)) {
    throw new Error("REAPER executable does not exist or is not executable");
  }

  const detectedFfmpeg = options.ffmpegExecutable ?? await firstExecutable([
    ...pathCandidates(environment, "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]);
  if (!detectedFfmpeg) {
    throw new Error("FFmpeg was not detected; install it or pass --ffmpeg-executable");
  }
  const ffmpegExecutable = absoluteMachinePath(detectedFfmpeg, "FFmpeg executable");
  if (!await executable(ffmpegExecutable)) {
    throw new Error("FFmpeg executable does not exist or is not executable");
  }

  const reaperResourcePath = absoluteMachinePath(
    options.reaperResourcePath ?? join(homeDirectory, "Library", "Application Support", "REAPER"),
    "REAPER resource path",
  );
  if (!await directory(reaperResourcePath)) {
    throw new Error("REAPER resource path was not detected; pass --reaper-resource-path");
  }

  const applicationRoot = join(homeDirectory, "Library", "Application Support", "REAPER Mixing Agent");
  const runtimeRoot = absoluteMachinePath(options.runtimeRoot ?? join(applicationRoot, "runtime"), "runtime root");
  const audioWorkRoot = absoluteMachinePath(
    options.audioWorkRoot ?? join(homeDirectory, "Music", "REAPER Mixing Agent"),
    "audio work root",
  );
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(audioWorkRoot, { recursive: true });
  await chmod(runtimeRoot, 0o700);
  await chmod(audioWorkRoot, 0o700);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, renderLocalConfig({
    reaperExecutable,
    ffmpegExecutable,
    reaperResourcePath,
    runtimeRoot,
    audioWorkRoot,
    providers,
    ...(defaultModel ? { defaultModel } : {}),
    ...(mixPlannerModel ? { mixPlannerModel } : {}),
  }), { encoding: "utf8", flag: "wx", mode: 0o600 });

  return {
    configPath,
    runtimeRoot,
    audioWorkRoot,
    apiKeyEnvs: [...new Set(providers.map((provider) => provider.apiKeyEnv))],
  };
}
