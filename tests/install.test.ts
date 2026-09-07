import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installBridge } from "../src/bridge/install.js";
import { runCli } from "../src/cli.js";
import { writeConfig } from "./helpers.js";

test("installs the bridge and a configured launcher in the REAPER resource directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-install-"));
  const sourcePath = join(directory, "MixingAgentBridge.lua");
  const workerSourcePath = join(directory, "RenderWorker.lua");
  await writeFile(sourcePath, "-- bridge source\n", "utf8");
  await writeFile(workerSourcePath, "-- worker source\n", "utf8");

  const result = await installBridge({
    reaperResourcePath: join(directory, "REAPER"),
    runtimeRoot: join(directory, "runtime root"),
    audioWorkRoot: join(directory, "audio root"),
    bridgeInstanceId: "main",
    sourcePath,
    workerSourcePath,
  });

  assert.equal(await readFile(result.bridgeScriptPath, "utf8"), "-- bridge source\n");
  assert.equal(await readFile(result.renderWorkerScriptPath, "utf8"), "-- worker source\n");
  const launcher = await readFile(result.launcherScriptPath, "utf8");
  assert.match(launcher, /SetExtState\(section, "runtime_root", ".*runtime root", true\)/);
  assert.match(launcher, /SetExtState\(section, "artifact_root", ".*audio root", true\)/);
  assert.match(launcher, /SetExtState\(section, "bridge_instance_id", "main", true\)/);
  assert.ok(launcher.includes(`dofile("${result.bridgeScriptPath}")`));
});

test("bridge install CLI reports the launcher that REAPER should load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-install-cli-"));
  const configPath = await writeConfig(directory, { runtimeRoot: join(directory, "runtime") });
  const sourcePath = join(directory, "MixingAgentBridge.lua");
  const workerSourcePath = join(directory, "RenderWorker.lua");
  await writeFile(sourcePath, "-- bridge source\n", "utf8");
  await writeFile(workerSourcePath, "-- worker source\n", "utf8");
  const output: string[] = [];

  const exitCode = await runCli(
    [
      "node",
      "mixing-agent",
      "bridge",
      "install",
      "--config",
      configPath,
      "--bridge-instance",
      "main",
    ],
    { bridgeSourcePath: sourcePath, renderWorkerSourcePath: workerSourcePath, write: (line) => output.push(line) },
  );

  assert.equal(exitCode, 0);
  const result = JSON.parse(output.join("\n")) as { launcherScriptPath: string };
  assert.equal(
    result.launcherScriptPath,
    join(directory, "reaper-resource/Scripts/REAPER Mixing Agent/StartMixingAgentBridge.lua"),
  );
});

test("bridge installer rejects unsafe instance ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-install-invalid-"));
  const sourcePath = join(directory, "MixingAgentBridge.lua");
  const workerSourcePath = join(directory, "RenderWorker.lua");
  await writeFile(sourcePath, "-- bridge source\n", "utf8");
  await writeFile(workerSourcePath, "-- worker source\n", "utf8");

  await assert.rejects(
    installBridge({
      reaperResourcePath: join(directory, "REAPER"),
      runtimeRoot: join(directory, "runtime"),
      audioWorkRoot: join(directory, "audio"),
      bridgeInstanceId: "../escape",
      sourcePath,
      workerSourcePath,
    }),
    /bridge instance id/,
  );
});
