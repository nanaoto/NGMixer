import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import TOML from "@iarna/toml";
import { z } from "zod";

const absolutePath = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const loopbackHost = z.enum(["127.0.0.1", "::1", "localhost"]);
const port = z.number().int().min(1).max(65_535);
const positiveMilliseconds = z.number().int().positive();
const disabled = z.literal(false, { error: "must remain false" });
const environmentVariableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");
const managedRuntimeEnvironmentNames = new Set([
  "NAPCAT_ONEBOT_TOKEN",
  "RMA_NAPCAT_URL",
  "RMA_NAPCAT_TOKEN_ENV",
  "RMA_QQ_ACCOUNT_ID",
  "RMA_QQ_GROUP_ID",
  "RMA_QQ_GROUP_IDS",
  "RMA_QQ_PRIVATE_USER_IDS",
  "RMA_QQ_OUTBOUND_STAGING_ROOT",
]);
const providerRouteName = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  "must be a provider route name",
);
const modelRouteSchema = z.strictObject({
  provider: providerRouteName,
  model: z.string().min(1),
});
const modelSelectionSchema = modelRouteSchema.extend({
  fallbacks: z.array(modelRouteSchema).default([]),
});
const providerModelSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  context_window: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
});
const providerRouteSchema = z.strictObject({
  display_name: z.string().min(1).optional(),
  api: z.enum(["openai-completions", "openai-responses", "anthropic-messages"]),
  base_url: z.string().url(),
  api_key_env: environmentVariableName,
  models: z.array(providerModelSchema).min(1),
});
const llmSchema = z.strictObject({
  default: modelSelectionSchema,
  mix_planner: modelSelectionSchema,
  providers: z.record(providerRouteName, providerRouteSchema).refine(
    (providers) => Object.keys(providers).length > 0,
    "must configure at least one provider route",
  ),
});
const legacyProviderSchema = z.strictObject({
  base_url: z.string().url(),
  model: z.string().min(1),
  api_key_env: environmentVariableName,
});

const rawConfigSchema = z.strictObject({
  paths: z.strictObject({
    reaper_executable: absolutePath,
    ffmpeg_executable: absolutePath,
    reaper_resource_path: absolutePath,
    runtime_root: absolutePath,
    audio_work_root: absolutePath,
  }),
  network: z.strictObject({
    daemon_host: loopbackHost,
    daemon_port: port,
    dsh_host: loopbackHost,
    dsh_port: port,
  }),
  provider: legacyProviderSchema.optional(),
  llm: llmSchema.optional(),
  reaper: z.strictObject({
    poll_interval_ms: positiveMilliseconds,
    command_timeout_ms: positiveMilliseconds,
    render_timeout_ms: positiveMilliseconds,
  }),
  safety: z.strictObject({
    allow_network_audio_upload: disabled,
    allow_source_media_write: disabled,
    allow_gui_coordinate_control: disabled,
  }),
}).superRefine((config, context) => {
  if (config.provider !== undefined && config.llm !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["llm"],
      message: "configure only one of llm or legacy provider",
    });
    return;
  }
  if (config.provider) {
    if (managedRuntimeEnvironmentNames.has(config.provider.api_key_env)) {
      context.addIssue({
        code: "custom",
        path: ["provider", "api_key_env"],
        message: "conflicts with a managed runtime variable",
      });
    }
    return;
  }
  if (!config.llm) return;
  for (const [routeName, route] of Object.entries(config.llm.providers)) {
    if (managedRuntimeEnvironmentNames.has(route.api_key_env)) {
      context.addIssue({
        code: "custom",
        path: ["llm", "providers", routeName, "api_key_env"],
        message: "conflicts with a managed runtime variable",
      });
    }
  }
  for (const [selectionName, selection] of [
    ["default", config.llm.default],
    ["mix_planner", config.llm.mix_planner],
  ] as const) {
    for (const [index, candidate] of [selection, ...selection.fallbacks].entries()) {
      const path = index === 0
        ? ["llm", selectionName]
        : ["llm", selectionName, "fallbacks", index - 1];
      const route = config.llm.providers[candidate.provider];
      if (!route) {
        context.addIssue({
          code: "custom",
          path: [...path, "provider"],
          message: `references unknown provider route ${candidate.provider}`,
        });
      } else if (!route.models.some((model) => model.id === candidate.model)) {
        context.addIssue({
          code: "custom",
          path: [...path, "model"],
          message: `references unknown model ${candidate.model} on route ${candidate.provider}`,
        });
      }
    }
  }
});

export interface LlmModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly fallbacks?: readonly LlmModelRoute[];
}

export interface LlmModelRoute {
  readonly provider: string;
  readonly model: string;
}

export interface LlmProviderModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface LlmProviderRoute {
  readonly displayName?: string;
  readonly api: "openai-completions" | "openai-responses" | "anthropic-messages";
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly models: readonly LlmProviderModel[];
}

export interface LocalConfig {
  readonly paths: {
    readonly reaperExecutable: string;
    readonly ffmpegExecutable: string;
    readonly reaperResourcePath: string;
    readonly runtimeRoot: string;
    readonly audioWorkRoot: string;
  };
  readonly network: {
    readonly daemonHost: "127.0.0.1" | "::1" | "localhost";
    readonly daemonPort: number;
    readonly dshHost: "127.0.0.1" | "::1" | "localhost";
    readonly dshPort: number;
  };
  readonly llm?: {
    readonly default: LlmModelSelection;
    readonly mixPlanner: LlmModelSelection;
    readonly providers: Readonly<Record<string, LlmProviderRoute>>;
  };
  readonly reaper: {
    readonly pollIntervalMs: number;
    readonly commandTimeoutMs: number;
    readonly renderTimeoutMs: number;
  };
  readonly safety: {
    readonly allowNetworkAudioUpload: false;
    readonly allowSourceMediaWrite: false;
    readonly allowGuiCoordinateControl: false;
  };
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function issueMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "config"}: ${issue.message}`)
    .join("; ");
}

function plainTomlValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainTomlValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainTomlValue(item)]));
}

export async function loadConfig(path: string): Promise<LocalConfig> {
  let parsed: unknown;
  try {
    parsed = TOML.parse(await readFile(path, "utf8"));
  } catch {
    throw new ConfigError("unable to read or parse local configuration");
  }

  const result = rawConfigSchema.safeParse(plainTomlValue(parsed));
  if (!result.success) {
    throw new ConfigError(issueMessage(result.error));
  }

  const raw = result.data;
  const legacy = raw.provider;
  const llm = raw.llm ?? (legacy ? {
    default: { provider: "primary", model: legacy!.model, fallbacks: [] },
    mix_planner: { provider: "primary", model: legacy!.model, fallbacks: [] },
    providers: {
      primary: {
        api: "openai-completions" as const,
        base_url: legacy!.base_url,
        api_key_env: legacy!.api_key_env,
        models: [{ id: legacy!.model }],
      },
    },
  } : undefined);
  return {
    paths: {
      reaperExecutable: raw.paths.reaper_executable,
      ffmpegExecutable: raw.paths.ffmpeg_executable,
      reaperResourcePath: raw.paths.reaper_resource_path,
      runtimeRoot: raw.paths.runtime_root,
      audioWorkRoot: raw.paths.audio_work_root,
    },
    network: {
      daemonHost: raw.network.daemon_host,
      daemonPort: raw.network.daemon_port,
      dshHost: raw.network.dsh_host,
      dshPort: raw.network.dsh_port,
    },
    ...(llm ? { llm: {
      default: {
        provider: llm.default.provider,
        model: llm.default.model,
        ...(llm.default.fallbacks.length === 0 ? {} : { fallbacks: llm.default.fallbacks }),
      },
      mixPlanner: {
        provider: llm.mix_planner.provider,
        model: llm.mix_planner.model,
        ...(llm.mix_planner.fallbacks.length === 0 ? {} : { fallbacks: llm.mix_planner.fallbacks }),
      },
      providers: Object.fromEntries(Object.entries(llm.providers).map(([route, provider]) => [route, {
        ...(provider.display_name === undefined ? {} : { displayName: provider.display_name }),
        api: provider.api,
        baseUrl: provider.base_url,
        apiKeyEnv: provider.api_key_env,
        models: provider.models.map((model) => ({
          id: model.id,
          ...(model.name === undefined ? {} : { name: model.name }),
          ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }),
          ...(model.max_tokens === undefined ? {} : { maxTokens: model.max_tokens }),
        })),
      }])),
    } } : {}),
    reaper: {
      pollIntervalMs: raw.reaper.poll_interval_ms,
      commandTimeoutMs: raw.reaper.command_timeout_ms,
      renderTimeoutMs: raw.reaper.render_timeout_ms,
    },
    safety: {
      allowNetworkAudioUpload: raw.safety.allow_network_audio_upload,
      allowSourceMediaWrite: raw.safety.allow_source_media_write,
      allowGuiCoordinateControl: raw.safety.allow_gui_coordinate_control,
    },
  };
}
