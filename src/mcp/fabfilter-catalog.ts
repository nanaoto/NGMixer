import { scanStudioInventory, type ReaperPlugin } from "../catalog/inventory.js";
import { loadConfig } from "../config.js";

export type FabFilterAutomation = "profiled" | "inventory-only";

export interface FabFilterInstallationIdentity {
  readonly format: "VST3" | "CLAP";
  readonly reaperCacheKey: string;
  readonly reaperName: string;
}

export interface InstalledFabFilterPlugin {
  readonly product: string;
  readonly formats: ReadonlyArray<"VST3" | "CLAP">;
  readonly preferredReaperName: string;
  readonly installations: readonly FabFilterInstallationIdentity[];
  readonly preferredInstallation: FabFilterInstallationIdentity;
  readonly automation: FabFilterAutomation;
}

export interface FabFilterCapability {
  readonly schema: "rma.fabfilter-capability/v1";
  readonly product: string;
  readonly category: string;
  readonly semanticControls: readonly string[];
  readonly automation: FabFilterAutomation;
}

const capabilityProfiles: Readonly<Record<string, Omit<FabFilterCapability, "schema" | "product">>> = {
  "Pro-Q 4": {
    category: "equalizer",
    semanticControls: ["air", "brightness", "high-pass", "resonance-control"],
    automation: "profiled",
  },
  "Pro-C 2": {
    category: "compressor",
    semanticControls: ["threshold", "ratio", "attack", "release", "mix"],
    automation: "profiled",
  },
  "Pro-DS": {
    category: "de-esser",
    semanticControls: ["threshold", "range", "detection-band", "audition"],
    automation: "profiled",
  },
  "Pro-L 2": {
    category: "limiter",
    semanticControls: ["gain", "output-ceiling", "true-peak", "oversampling"],
    automation: "profiled",
  },
};

type SupportedFabFilterPlugin = ReaperPlugin & { readonly format: "VST3" | "CLAP" };

function isSupportedFormat(plugin: ReaperPlugin): plugin is SupportedFabFilterPlugin {
  return plugin.status === "recognized" && (plugin.format === "VST3" || plugin.format === "CLAP");
}

function fabFilterProduct(plugin: SupportedFabFilterPlugin): string | undefined {
  const vendorMarker = plugin.name.search(/\s*\(FabFilter(?:, LLC)?\)/iu);
  if (vendorMarker < 0 && !/^FabFilter[ _-]/iu.test(plugin.cacheKey)) return undefined;
  const displayName = vendorMarker < 0 ? plugin.name : plugin.name.slice(0, vendorMarker);
  const product = displayName
    .replace(/^FabFilter[ _-]+/iu, "")
    .replace(/!!!VSTi$/u, "")
    .trim();
  return product || undefined;
}

function formatRank(format: "VST3" | "CLAP"): number {
  return format === "VST3" ? 0 : 1;
}

export function catalogFabFilterPlugins(
  plugins: readonly ReaperPlugin[],
): InstalledFabFilterPlugin[] {
  const grouped = new Map<string, SupportedFabFilterPlugin[]>();
  for (const plugin of plugins) {
    if (!isSupportedFormat(plugin)) continue;
    const product = fabFilterProduct(plugin);
    if (!product) continue;
    const candidates = grouped.get(product) ?? [];
    candidates.push(plugin);
    grouped.set(product, candidates);
  }
  return [...grouped.entries()].map(([product, candidates]) => {
    const installations = [...candidates]
      .sort((left, right) => formatRank(left.format) - formatRank(right.format))
      .map((candidate) => ({
        format: candidate.format,
        reaperCacheKey: candidate.cacheKey,
        reaperName: candidate.name,
      }));
    const preferred = installations[0]!;
    const formats = [...new Set(installations.map((installation) => installation.format))];
    return {
      product,
      formats,
      preferredReaperName: preferred.reaperName,
      installations,
      preferredInstallation: preferred,
      automation: capabilityProfiles[product]?.automation ?? "inventory-only",
    };
  }).sort((left, right) => left.product.localeCompare(right.product));
}

export function describeFabFilterProduct(product: string): FabFilterCapability {
  const profile = capabilityProfiles[product];
  return {
    schema: "rma.fabfilter-capability/v1",
    product,
    category: profile?.category ?? "unprofiled",
    semanticControls: profile?.semanticControls ?? [],
    automation: profile?.automation ?? "inventory-only",
  };
}

export async function installedFabFilterPlugins(configPath: string): Promise<InstalledFabFilterPlugin[]> {
  const config = await loadConfig(configPath);
  const inventory = await scanStudioInventory({
    reaperResourcePath: config.paths.reaperResourcePath,
    pluginRoots: [],
    libraryRoots: [],
  });
  return catalogFabFilterPlugins(inventory.reaperPlugins);
}
