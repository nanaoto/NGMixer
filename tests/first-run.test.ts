import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

import { collectTerminalInstallationRequest, ensureFirstRun, type FirstRunPrompter } from "../src/first-run.js";

test("start enters onboarding only until a local installation has been configured", async (context) => {
  context.after(() => { delete process.env.RMA_PROVIDER_KEY; });
  const root = await mkdtemp(join(tmpdir(), "rma-first-run-"));
  const projectRoot = join(root, "project");
  const reaperExecutable = join(root, "REAPER");
  const ffmpegExecutable = join(root, "ffmpeg");
  const reaperResourcePath = join(root, "REAPER-resource");
  const configPath = join(projectRoot, "config", "local.toml");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(reaperResourcePath, { recursive: true });
  await writeFile(reaperExecutable, "executable", { mode: 0o700 });
  await writeFile(ffmpegExecutable, "executable", { mode: 0o700 });
  let collections = 0;
  const options = {
    projectRoot,
    configPath,
    environmentPath: join(root, "private", "runtime.env"),
    collect: async () => {
      collections += 1;
      return {
        projectRoot,
        configPath,
        environmentPath: join(root, "private", "runtime.env"),
        reaperExecutable,
        ffmpegExecutable,
        reaperResourcePath,
        runtimeRoot: join(root, "runtime"),
        audioWorkRoot: join(root, "projects"),
        modelConfiguration: "dsh" as const,
        providers: [],
        pluginRoots: [],
        libraryRoots: [],
        channel: { kind: "web" as const },
      };
    },
    installationDependencies: {
      installBridge: async () => ({ launcherPath: join(root, "StartMixingAgentBridge.lua") }),
    },
  };

  assert.equal((await ensureFirstRun(options)).configured, true);
  assert.equal((await ensureFirstRun(options)).configured, false);
  assert.equal(collections, 1);
  assert.equal((await loadConfig(configPath)).llm, undefined);
});

test("first-run leaves provider, key, and model selection to the DSH WebUI", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-first-run-models-"));
  const prompt: FirstRunPrompter = {
    write: () => undefined,
    ask: async (message, defaultValue) => {
      assert.doesNotMatch(message, /模型 ID|API|端点|接口协议/u);
      return defaultValue ?? "fixture";
    },
    secret: async () => { throw new Error("first-run must not ask for an LLM secret"); },
    confirm: async () => false,
    choose: async (_message, choices, defaultIndex = 0) => {
      const choice = choices[defaultIndex];
      if (!choice) throw new Error("prompt exposed an empty choice list");
      return choice;
    },
  };

  const request = await collectTerminalInstallationRequest({
    projectRoot: join(root, "project"),
    configPath: join(root, "project/config/local.toml"),
    environmentPath: join(root, "private/runtime.env"),
    homeDirectory: root,
    prompter: prompt,
  });

  assert.equal(request.modelConfiguration, "dsh");
  assert.deepEqual(request.providers, []);
  assert.equal(request.defaultModel, undefined);
});
