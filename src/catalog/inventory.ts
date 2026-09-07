import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type PluginFormat = "VST" | "VST3" | "CLAP" | "AU" | "unknown";

export interface ReaperPlugin {
  readonly name: string;
  readonly format: "VST" | "VST3" | "CLAP";
  readonly cacheKey: string;
  readonly status: "recognized" | "failed";
}

export interface PluginBundle {
  readonly name: string;
  readonly format: PluginFormat;
  readonly path: string;
}

export interface SoundLibrary {
  readonly product: string;
  readonly path: string;
  readonly family: "Kontakt" | "Spectrasonics" | "Waves" | "other";
}

export interface StudioInventory {
  readonly schema: "rma.studio-inventory/v1";
  readonly scannedAt: string;
  readonly reaperPlugins: readonly ReaperPlugin[];
  readonly pluginBundles: readonly PluginBundle[];
  readonly soundLibraries: readonly SoundLibrary[];
}

export interface ScanStudioInventoryOptions {
  readonly reaperResourcePath: string;
  readonly pluginRoots: readonly string[];
  readonly libraryRoots: readonly string[];
  readonly scannedAt?: string;
}

async function optionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function matchingCacheText(resourcePath: string, pattern: RegExp): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(resourcePath)).filter((name) => pattern.test(name)).sort();
  } catch {
    return "";
  }
  return (await Promise.all(names.map((name) => optionalText(join(resourcePath, name))))).join("\n");
}

function parseVstCache(contents: string): ReaperPlugin[] {
  const plugins: ReaperPlugin[] = [];
  let inVstCache = false;
  for (const line of contents.split(/\r?\n/)) {
    const section = /^\[(.+)]$/.exec(line);
    if (section) {
      inVstCache = section[1] === "vstcache";
      continue;
    }
    if (!inVstCache || !line || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    const cacheKey = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const firstComma = value.indexOf(",");
    const identityMarker = value.indexOf("{");
    const nameSeparator = value.indexOf(",", identityMarker >= 0 ? identityMarker : firstComma + 1);
    const recognized = nameSeparator >= 0;
    const name = recognized ? value.slice(nameSeparator + 1) : cacheKey;
    if (name) plugins.push({
      name,
      format: cacheKey.toLowerCase().endsWith(".vst3") ? "VST3" : "VST",
      cacheKey,
      status: recognized ? "recognized" : "failed",
    });
  }
  return plugins;
}

function parseClapCache(contents: string): ReaperPlugin[] {
  const plugins: ReaperPlugin[] = [];
  let section = "";
  for (const line of contents.split(/\r?\n/)) {
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1] ?? "";
      continue;
    }
    if (!section || line.startsWith("_=") || !line.includes("|")) continue;
    const name = line.slice(line.indexOf("|") + 1).trim();
    if (name) plugins.push({ name, format: "CLAP", cacheKey: section, status: "recognized" });
  }
  return plugins;
}

function formatForPath(path: string): PluginFormat {
  switch (extname(path).toLowerCase()) {
    case ".vst": return "VST";
    case ".vst3": return "VST3";
    case ".clap": return "CLAP";
    case ".component": return "AU";
    default: return "unknown";
  }
}

async function scanPluginRoot(root: string): Promise<PluginBundle[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => [".vst", ".vst3", ".clap", ".component"].includes(extname(entry.name).toLowerCase()))
      .map((entry) => {
        const path = join(root, entry.name);
        return { name: basename(entry.name, extname(entry.name)), format: formatForPath(path), path };
      });
  } catch {
    return [];
  }
}

const libraryMatchers: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly product: (name: string) => string;
  readonly family: SoundLibrary["family"];
}> = [
  { pattern: /^Kontakt Factory Library 2(?: Library)?$/i, product: () => "Kontakt Factory Library 2", family: "Kontakt" },
  { pattern: /^Omnisphere$/i, product: () => "Omnisphere", family: "Spectrasonics" },
  { pattern: /^Sonic Extensions$/i, product: () => "Sonic Extensions", family: "Spectrasonics" },
  { pattern: /^Waves .*Pack$/i, product: (name) => name, family: "Waves" },
];

async function scanLibraryRoot(root: string): Promise<SoundLibrary[]> {
  const candidates: string[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(root, entry.name);
      candidates.push(child);
      try {
        for (const nested of await readdir(child, { withFileTypes: true })) {
          if (nested.isDirectory()) candidates.push(join(child, nested.name));
        }
      } catch {
        // A readable top-level library is still useful when its internals are protected.
      }
    }
  } catch {
    return [];
  }

  const libraries: SoundLibrary[] = [];
  for (const path of candidates) {
    const name = basename(path);
    const match = libraryMatchers.find((candidate) => candidate.pattern.test(name));
    if (match && (await stat(path)).isDirectory()) {
      libraries.push({ product: match.product(name), path, family: match.family });
      continue;
    }
    try {
      const children = new Set((await readdir(path, { withFileTypes: true })).map((entry) => entry.name.toLowerCase()));
      if (children.has("instruments") && children.has("samples")) {
        libraries.push({ product: name.replace(/\s+Library$/i, ""), path, family: "Kontakt" });
      }
    } catch {
      // Product-name matches above are still useful when marker folders are protected.
    }
  }
  return libraries;
}

export async function scanStudioInventory(options: ScanStudioInventoryOptions): Promise<StudioInventory> {
  const [vstCache, clapCache, pluginGroups, libraryGroups] = await Promise.all([
    matchingCacheText(options.reaperResourcePath, /^reaper-vstplugins.*\.ini$/iu),
    matchingCacheText(options.reaperResourcePath, /^reaper-clap.*\.ini$/iu),
    Promise.all(options.pluginRoots.map(scanPluginRoot)),
    Promise.all(options.libraryRoots.map(scanLibraryRoot)),
  ]);
  const soundLibraries = libraryGroups.flat().filter((library, index, all) =>
    all.findIndex((candidate) => candidate.product === library.product && candidate.path === library.path) === index,
  );
  const reaperPlugins = [...parseVstCache(vstCache), ...parseClapCache(clapCache)]
    .filter((plugin, index, all) => all.findIndex((candidate) =>
      candidate.name === plugin.name
      && candidate.format === plugin.format
      && candidate.cacheKey === plugin.cacheKey
      && candidate.status === plugin.status) === index)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    schema: "rma.studio-inventory/v1",
    scannedAt: options.scannedAt ?? new Date().toISOString(),
    reaperPlugins,
    pluginBundles: pluginGroups.flat().sort((a, b) => a.name.localeCompare(b.name)),
    soundLibraries: soundLibraries.sort((a, b) => a.product.localeCompare(b.product)),
  };
}
