import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { initializeInstallation } from "../src/onboarding.js";

test("first-run installation configures multiple models, scans plug-ins, and falls back to DSH Web", async (context) => {
  context.after(() => {
    delete process.env.RMA_CHAT_KEY;
    delete process.env.RMA_MIX_KEY;
  });
  const root = await mkdtemp(join(tmpdir(), "rma-onboarding-"));
  const projectRoot = join(root, "project");
  const reaperExecutable = join(root, "REAPER");
  const ffmpegExecutable = join(root, "ffmpeg");
  const reaperResourcePath = join(root, "REAPER-resource");
  const runtimeRoot = join(root, "runtime");
  const audioWorkRoot = join(root, "projects");
  const configPath = join(projectRoot, "config", "local.toml");
  const environmentPath = join(root, "private", "runtime.env");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(reaperResourcePath, { recursive: true });
  await writeFile(reaperExecutable, "executable", { mode: 0o700 });
  await writeFile(ffmpegExecutable, "executable", { mode: 0o700 });
  await writeFile(join(reaperResourcePath, "reaper-vstplugins_arm64.ini"), [
    "[vstcache]",
    "FabFilter_Pro_Q_4.vst3=ABC,123{uid,FabFilter Pro-Q 4 (FabFilter, LLC)",
    "",
  ].join("\n"));

  const result = await initializeInstallation({
    projectRoot,
    configPath,
    environmentPath,
    reaperExecutable,
    ffmpegExecutable,
    reaperResourcePath,
    runtimeRoot,
    audioWorkRoot,
    providers: [
      {
        route: "chat",
        displayName: "Chat endpoint",
        api: "openai-responses",
        baseUrl: "https://chat.example.test/v1",
        apiKeyEnv: "RMA_CHAT_KEY",
        apiKey: "chat-secret",
        models: ["chat-model"],
      },
      {
        route: "mix",
        api: "anthropic-messages",
        baseUrl: "https://mix.example.test/v1",
        apiKeyEnv: "RMA_MIX_KEY",
        apiKey: "mix-secret",
        models: ["mix-model"],
      },
    ],
    defaultModel: { provider: "chat", model: "chat-model" },
    mixPlannerModel: { provider: "mix", model: "mix-model" },
    pluginRoots: [],
    libraryRoots: [],
    channel: { kind: "web" },
  }, {
    installBridge: async () => ({ launcherPath: join(root, "StartMixingAgentBridge.lua") }),
  });

  assert.equal(result.channel, "web");
  assert.equal(result.webUi, true);
  const config = await loadConfig(configPath);
  assert.ok(config.llm);
  assert.equal(config.llm.default.provider, "chat");
  assert.equal(config.llm.mixPlanner.provider, "mix");
  assert.deepEqual(Object.keys(config.llm.providers), ["chat", "mix"]);
  const environment = await readFile(environmentPath, "utf8");
  assert.match(environment, /^RMA_CHAT_KEY=chat-secret$/mu);
  assert.match(environment, /^RMA_MIX_KEY=mix-secret$/mu);
  assert.equal((await stat(environmentPath)).mode & 0o777, 0o600);
  const inventory = JSON.parse(await readFile(result.inventoryPath, "utf8")) as {
    reaperPlugins: Array<{ name: string }>;
  };
  assert.equal(inventory.reaperPlugins[0]?.name, "FabFilter Pro-Q 4 (FabFilter, LLC)");
  assert.equal((await stat(result.inventoryPath)).mode & 0o777, 0o600);
});

test("a failed channel setup restores credentials and a retry accepts the newly entered key", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "rma-onboarding-retry-"));
  const projectRoot = join(root, "project");
  const reaperExecutable = join(root, "REAPER");
  const ffmpegExecutable = join(root, "ffmpeg");
  const reaperResourcePath = join(root, "REAPER-resource");
  const environmentPath = join(root, "private", "runtime.env");
  const configPath = join(projectRoot, "config", "local.toml");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(reaperResourcePath, { recursive: true });
  await mkdir(join(root, "private"), { recursive: true });
  await writeFile(reaperExecutable, "executable", { mode: 0o700 });
  await writeFile(ffmpegExecutable, "executable", { mode: 0o700 });
  await writeFile(environmentPath, "RMA_RETRY_KEY=old-key\n", { mode: 0o600 });
  context.after(() => { delete process.env.RMA_RETRY_KEY; });
  const baseRequest = {
    projectRoot,
    configPath,
    environmentPath,
    reaperExecutable,
    ffmpegExecutable,
    reaperResourcePath,
    runtimeRoot: join(root, "runtime"),
    audioWorkRoot: join(root, "projects"),
    providers: [{
      route: "primary",
      api: "openai-completions" as const,
      baseUrl: "https://provider.example.test/v1",
      apiKeyEnv: "RMA_RETRY_KEY",
      apiKey: "new-key",
      models: ["model"],
    }],
    defaultModel: { provider: "primary", model: "model" },
    mixPlannerModel: { provider: "primary", model: "model" },
    pluginRoots: [],
    libraryRoots: [],
  };
  const installBridge = async () => ({ launcherPath: join(root, "StartMixingAgentBridge.lua") });

  await assert.rejects(initializeInstallation({
    ...baseRequest,
    channel: { kind: "qq", accountId: "12345", groupId: "23456", groupIds: [], privateUserIds: [] },
  }, {
    installBridge,
    configureQq: async () => { throw new Error("QQ unavailable"); },
  }), /QQ unavailable/u);
  assert.equal(await readFile(environmentPath, "utf8"), "RMA_RETRY_KEY=old-key\n");
  await assert.rejects(readFile(configPath, "utf8"), { code: "ENOENT" });

  await initializeInstallation({ ...baseRequest, channel: { kind: "web" } }, { installBridge });
  assert.equal(await readFile(environmentPath, "utf8"), [
    "RMA_RETRY_KEY=new-key",
    "",
  ].join("\n"));
});
