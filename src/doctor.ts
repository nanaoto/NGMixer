import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { satisfies } from "semver";

import { ConfigError, loadConfig } from "./config.js";

const require = createRequire(import.meta.url);

export interface DoctorReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export interface DoctorOptions {
  readonly keyless?: boolean;
  readonly nodeVersion?: string;
  readonly resolvePackageVersion?: (packageName: string) => Promise<string>;
}

interface ProjectManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const packageContracts = [
  ["DSH", "@deepseek-ai/dsh"],
  ["DSH agent", "@deepseek-ai/dsh-agent"],
  ["DSH agent presets", "@deepseek-ai/dsh-agent-presets"],
  ["DSH permission presets", "@deepseek-ai/dsh-permission-presets"],
  ["DSH LLM", "@deepseek-ai/dsh-llm"],
  ["DSH MCP client", "@deepseek-ai/dsh-mcp-client"],
  ["DSH session", "@deepseek-ai/dsh-session"],
  ["DSH tools", "@deepseek-ai/dsh-tools"],
  ["Cordis", "@deepseek-ai/cordis"],
] as const;

async function nearestExistingWritableParent(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      const details = await stat(candidate);
      if (!details.isDirectory()) {
        throw new Error("exists but is not a directory");
      }
      await access(candidate, constants.W_OK);
      return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

function supportsPinnedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 22 && minor >= 19;
}

async function installedPackageVersion(packageName: string): Promise<string> {
  const manifestPath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error(`${packageName} package manifest has no version`);
  }
  return manifest.version;
}

async function declaredPackageRanges(): Promise<Readonly<Record<string, string>>> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as ProjectManifest;
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

export async function runDoctor(configPath: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const lines: string[] = [];
  let config;
  try {
    config = await loadConfig(configPath);
    lines.push(`PASS config ${configPath}`);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "unexpected configuration error";
    return { ok: false, lines: [`FAIL config ${message}`] };
  }

  let ok = true;
  const roots = [
    ["runtime_root", config.paths.runtimeRoot],
    ["audio_work_root", config.paths.audioWorkRoot],
  ] as const;
  for (const [name, path] of roots) {
    try {
      const parent = await nearestExistingWritableParent(path);
      lines.push(`PASS ${name} parent ${parent} is writable`);
    } catch {
      ok = false;
      lines.push(`FAIL ${name} has no existing writable directory parent`);
    }
  }

  const nodeVersion = options.nodeVersion ?? process.version;
  if (supportsPinnedNode(nodeVersion)) {
    lines.push(`PASS Node ${nodeVersion}; expected >=22.19 <23`);
  } else {
    ok = false;
    lines.push(`FAIL Node ${nodeVersion}; expected >=22.19 <23`);
  }
  try {
    const ranges = await declaredPackageRanges();
    const resolveVersion = options.resolvePackageVersion ?? installedPackageVersion;
    for (const [label, packageName] of packageContracts) {
      const range = ranges[packageName];
      if (!range) {
        ok = false;
        lines.push(`FAIL ${label} has no declared compatibility range`);
        continue;
      }
      try {
        const installedVersion = await resolveVersion(packageName);
        if (satisfies(installedVersion, range, { includePrerelease: true })) {
          lines.push(`PASS installed ${label} ${installedVersion} satisfies ${range}`);
        } else {
          ok = false;
          lines.push(`FAIL installed ${label} ${installedVersion} does not satisfy ${range}`);
        }
      } catch {
        ok = false;
        lines.push(`FAIL installed ${label} version is unavailable`);
      }
    }
  } catch {
    ok = false;
    lines.push("FAIL project package compatibility manifest is unavailable");
  }

  if (options.keyless) {
    lines.push("PASS provider credentials skipped (--keyless)");
  } else if (!config.llm) {
    lines.push("PASS model credentials managed in DSH WebUI Settings → Models");
  } else {
    const credentialNames = new Set(
      Object.values(config.llm.providers).map((provider) => provider.apiKeyEnv),
    );
    for (const credentialName of credentialNames) {
      if (process.env[credentialName]) {
        lines.push(`PASS provider credential environment variable ${credentialName} is set`);
      } else {
        ok = false;
        lines.push(`FAIL provider credential environment variable ${credentialName} is not set`);
      }
    }
  }

  return { ok, lines };
}
