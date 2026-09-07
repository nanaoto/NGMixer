import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanStudioInventory } from "../src/catalog/inventory.js";

test("scanStudioInventory combines REAPER caches, bundles, and sound libraries", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-inventory-"));
  const resource = join(root, "REAPER");
  const vst3 = join(root, "VST3");
  const libraries = join(root, "SoundLibs");
  await mkdir(join(vst3, "FabFilter Pro-Q 4.vst3"), { recursive: true });
  await mkdir(join(libraries, "Kontakt Factory Library 2 Library", "Instruments"), { recursive: true });
  await mkdir(join(libraries, "STEAM", "Omnisphere"), { recursive: true });
  await mkdir(join(libraries, "Custom Choir Library", "Instruments"), { recursive: true });
  await mkdir(join(libraries, "Custom Choir Library", "Samples"), { recursive: true });
  await mkdir(resource, { recursive: true });
  await writeFile(
    join(resource, "reaper-vstplugins_arm64.ini"),
    "[vstcache]\nFabFilter_Pro_Q_4.vst3=ABC,123{uid,FabFilter Pro-Q 4 (FabFilter, LLC)\n\n[xvst3_compat]\nuid=not-a-plugin\n",
  );
  await writeFile(
    join(resource, "reaper-clap-macos-aarch64.ini"),
    "[FabFilter Pro-DS.clap]\n_=ABC\ncom.fabfilter.pro-ds=0|Pro-DS (FabFilter)\n",
  );
  await writeFile(
    join(resource, "reaper-vstplugins64.ini"),
    "[vstcache]\nIntel_Only.vst3=ABC,123{uid,Intel Only (Vendor)\n",
  );

  const inventory = await scanStudioInventory({
    reaperResourcePath: resource,
    pluginRoots: [vst3],
    libraryRoots: [libraries],
    scannedAt: "2026-08-19T00:00:00.000Z",
  });

  assert.equal(inventory.schema, "rma.studio-inventory/v1");
  assert.equal(inventory.reaperPlugins.some((plugin) => plugin.name.includes("Pro-Q 4")), true);
  assert.equal(inventory.reaperPlugins.some((plugin) => plugin.name === "FabFilter Pro-Q 4 (FabFilter, LLC)"), true);
  assert.equal(inventory.reaperPlugins.some((plugin) => plugin.cacheKey === "uid"), false);
  assert.equal(inventory.reaperPlugins.some((plugin) => plugin.name.includes("Pro-DS")), true);
  assert.equal(inventory.reaperPlugins.some((plugin) => plugin.name === "Intel Only (Vendor)"), true);
  assert.equal(inventory.reaperPlugins.every((plugin) => plugin.status === "recognized"), true);
  assert.equal(inventory.pluginBundles[0]?.format, "VST3");
  assert.deepEqual(inventory.soundLibraries.map((library) => library.product), [
    "Custom Choir",
    "Kontakt Factory Library 2",
    "Omnisphere",
  ]);
});
