import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseDshLaunchInvocation,
  prepareDshLaunch,
  qqOptionsFromEnvironment,
  renderDshPatch,
} from "../src/dsh/launch.js";

test("DSH launcher selects a one-shot headless profile without forwarding its local flag", () => {
  assert.deepEqual(parseDshLaunchInvocation(["--headless", "mix the current project"]), {
    profile: "headless",
    args: ["mix the current project"],
  });
  assert.deepEqual(parseDshLaunchInvocation(["--no-open", "--port", "3080"]), {
    profile: "web",
    args: ["--no-open", "--port", "3080"],
  });
});

test("DSH patch renders loader string paths rather than unevaluated expressions", () => {
  const patch = renderDshPatch({
    pluginPath: "/project with spaces/dist/dsh/mixing-plugin.js",
    fabFilterMcpServerPath: "/project with spaces/src/mcp/fabfilter-server.ts",
    reaperDocsMcpServerPath: "/project with spaces/src/mcp/reaper-docs-server.ts",
    studioInventoryMcpServerPath: "/project with spaces/src/mcp/studio-inventory-server.ts",
    studioInventoryPath: "/studio data/catalog/studio-inventory.json",
    configPath: "/project with spaces/config/local.toml",
    bridgeInstanceId: "main",
  });

  assert.ok(patch.includes('name: "/project with spaces/dist/dsh/mixing-plugin.js"'));
  assert.ok(patch.includes('configPath: "/project with spaces/config/local.toml"'));
  assert.match(
    patch,
    /- id: hmr\n  disabled: false\n  config:\n    root:\n      - "\/project with spaces\/dist"/u,
  );
  assert.equal(patch.includes("!!js"), false);
  assert.ok(patch.includes("name: \"@anionex/dsh-computer-use\""));
  assert.match(patch, /id: mcp-fabfilter[\s\S]*name: "@deepseek-ai\/dsh-mcp-client"/u);
  assert.match(patch, /serverName: "fabfilter"[\s\S]*transport: "stdio"/u);
  assert.ok(patch.includes('"/project with spaces/src/mcp/fabfilter-server.ts"'));
  assert.match(patch, /id: mcp-reaper-docs[\s\S]*name: "@deepseek-ai\/dsh-mcp-client"/u);
  assert.match(patch, /serverName: "reaper_docs"[\s\S]*transport: "stdio"/u);
  assert.ok(patch.includes('"/project with spaces/src/mcp/reaper-docs-server.ts"'));
  assert.match(patch, /serverName: "studio_inventory"[\s\S]*transport: "stdio"/u);
  assert.ok(patch.includes('"/studio data/catalog/studio-inventory.json"'));
  assert.ok(patch.includes("com.cockos.reaper"));
  assert.ok(patch.includes("control: true"));
  assert.equal(patch.includes("allowAllApps: true"), false);
});

test("DSH patch composes QQ transport, conversation agent, mixing runtime, and scoped Computer Use", () => {
  const patch = renderDshPatch({
    pluginPath: "/project/dist/dsh/mixing-plugin.js",
    modelFailoverPluginPath: "/project/dist/dsh/model-failover-plugin.js",
    fabFilterMcpServerPath: "/project/src/mcp/fabfilter-server.ts",
    reaperDocsMcpServerPath: "/project/src/mcp/reaper-docs-server.ts",
    configPath: "/project/config/local.toml",
    bridgeInstanceId: "main",
    llm: {
      default: {
        provider: "chat-main",
        model: "chat-model",
        fallbacks: [{ provider: "chat-backup", model: "chat-model" }],
      },
      mixPlanner: {
        provider: "mix-planner",
        model: "planner-model",
        fallbacks: [{ provider: "chat-backup", model: "chat-model" }],
      },
      providers: {
        "chat-main": {
          displayName: "Chat Main",
          api: "openai-responses",
          baseUrl: "https://chat.example.test/v1",
          apiKeyEnv: "CHAT_API_KEY",
          models: [{ id: "chat-model", contextWindow: 131072, maxTokens: 8192 }],
        },
        "chat-backup": {
          api: "openai-responses",
          baseUrl: "https://chat-backup.example.test/v1",
          apiKeyEnv: "CHAT_BACKUP_API_KEY",
          models: [{ id: "chat-model" }],
        },
        "mix-planner": {
          api: "openai-completions",
          baseUrl: "https://mix.example.test/v1",
          apiKeyEnv: "MIX_API_KEY",
          models: [{ id: "planner-model" }],
        },
      },
    },
    qq: {
      transportPluginPath: "/project/dist/plugins/qq-transport-plugin.js",
      agentPluginPath: "/project/dist/plugins/qq-agent-plugin.js",
      napCatUrl: "http://127.0.0.1:3000",
      outboundStagingRoot: "/qq-data/Documents/napcat/rma-outbound",
      tokenEnv: "NAPCAT_TOKEN",
      accountId: "42",
      groupId: "314",
      groupIds: ["2718"],
      privateUserIds: ["7"],
    },
  });

  assert.ok(patch.indexOf("id: reaper-mixing-agent") < patch.indexOf("id: qq-transport"));
  assert.ok(patch.indexOf("id: qq-transport") < patch.indexOf("id: qq-agent"));
  assert.match(patch, /privateUserIds:\n          - "7"/u);
  assert.match(patch, /outboundStagingRoot: "\/qq-data\/Documents\/napcat\/rma-outbound"/u);
  assert.match(patch, /id: qq-agent[\s\S]*trustedPrivateUserIds:\n          - "7"/u);
  assert.match(patch, /defaultGroupId: "314"/u);
  assert.match(patch, /allowAllApps: false/u);
  assert.match(patch, /- id: llm-deepseek\n  disabled: true/u);
  assert.match(patch, /- id: llm-pi-ai[\s\S]*"chat-main":[\s\S]*apiKeyEnv: "CHAT_API_KEY"/u);
  assert.equal(patch.includes("- insert:\n    - id: llm-pi-ai"), false);
  assert.match(patch, /baseURL: "https:\/\/mix\.example\.test\/v1"/u);
  assert.match(patch, /contextWindow: 131072[\s\S]*maxTokens: 8192/u);
  assert.match(patch, /id: agent-default-model[\s\S]*provider: "chat-main"[\s\S]*model: "chat-model"/u);
  assert.match(
    patch,
    /id: model-failover[\s\S]*name: "\/project\/dist\/dsh\/model-failover-plugin\.js"[\s\S]*provider: "chat-main"[\s\S]*provider: "chat-backup"/u,
  );
  assert.equal(patch.match(/          - routes:/gu)?.length, 1);
  assert.match(patch, /id: reaper-mixing-agent[\s\S]*plannerProvider: "mix-planner"[\s\S]*plannerModel: "planner-model"/u);
  assert.match(
    patch,
    /id: reaper-mixing-agent[\s\S]*plannerFallbacks:\n          - provider: "chat-backup"/u,
  );
  assert.ok(patch.indexOf("id: mcp-fabfilter") < patch.indexOf("id: qq-agent"));
  assert.ok(patch.indexOf("id: mcp-reaper-docs") < patch.indexOf("id: qq-agent"));
});

test("DSH launch preparation keeps generated profile state under var", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rma-dsh-launch-"));
  const prepared = await prepareDshLaunch(projectRoot, { bridgeInstanceId: "studio-a" });

  assert.equal(prepared.dshHome, join(projectRoot, "var/dsh/home"));
  assert.equal(prepared.patchPath, join(projectRoot, "var/dsh/mixing.patch.yml"));
  const patch = await readFile(prepared.patchPath, "utf8");
  assert.match(patch, /bridgeInstanceId: "studio-a"/);
  assert.ok(patch.includes(`name: ${JSON.stringify(join(projectRoot, "src/dsh/mixing-plugin.ts"))}`));
  assert.ok(patch.includes(JSON.stringify(join(projectRoot, "src/mcp/fabfilter-server.ts"))));
  assert.ok(patch.includes(JSON.stringify(join(projectRoot, "src/mcp/reaper-docs-server.ts"))));
  assert.ok(patch.includes(`- ${JSON.stringify(join(projectRoot, "src"))}`));
});

test("headless DSH preparation omits QQ transport even when the managed environment is present", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rma-dsh-headless-"));
  const prepared = await prepareDshLaunch(projectRoot, {
    qq: false,
    llm: {
      default: { provider: "primary", model: "chat-model" },
      mixPlanner: { provider: "primary", model: "chat-model" },
      providers: {
        primary: {
          api: "openai-completions",
          baseUrl: "https://chat.example.test/v1",
          apiKeyEnv: "CHAT_API_KEY",
          models: [{ id: "chat-model" }],
        },
      },
    },
  });
  const patch = await readFile(prepared.patchPath, "utf8");

  assert.doesNotMatch(patch, /id: qq-transport|id: qq-agent/u);
  assert.match(patch, /id: reaper-mixing-agent/u);
});

test("DSH launch requires and forwards the complete managed QQ environment", () => {
  const environment = {
    RMA_NAPCAT_URL: "http://127.0.0.1:3000",
    RMA_NAPCAT_TOKEN_ENV: "NAPCAT_ONEBOT_TOKEN",
    RMA_QQ_ACCOUNT_ID: "42",
    RMA_QQ_GROUP_ID: "314",
    RMA_QQ_OUTBOUND_STAGING_ROOT: "/qq-data/Documents/napcat/rma-outbound",
  };

  assert.equal(
    qqOptionsFromEnvironment("/project", environment)?.outboundStagingRoot,
    "/qq-data/Documents/napcat/rma-outbound",
  );
  const { RMA_QQ_OUTBOUND_STAGING_ROOT: _missing, ...incomplete } = environment;
  assert.throws(() => qqOptionsFromEnvironment("/project", incomplete), /requires RMA_NAPCAT_URL/u);
});

test("DSH launch refuses a persisted default model whose adapter route was removed", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rma-dsh-launch-"));
  const dshHome = join(projectRoot, "var/dsh/home");
  await mkdir(dshHome, { recursive: true });
  await writeFile(join(dshHome, "settings.yaml"), [
    "agent-default-model:",
    "  provider: deepseek-official",
    "  model: deepseek-v4-flash",
    "ui-theme:",
    "  mode: dark",
    "",
  ].join("\n"));

  await assert.rejects(prepareDshLaunch(projectRoot, {
    llm: {
      default: { provider: "primary", model: "chat-model" },
      mixPlanner: { provider: "primary", model: "chat-model" },
      providers: {
        primary: {
          api: "openai-completions",
          baseUrl: "https://chat.example.test/v1",
          apiKeyEnv: "CHAT_API_KEY",
          models: [{ id: "chat-model" }],
        },
      },
    },
  }), /settings\.yaml selects unavailable model route deepseek-official\/deepseek-v4-flash/u);
});


test("WebUI-managed models survive startup without a TOML route or model override", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rma-dsh-web-models-"));
  const home = join(projectRoot, "var/dsh/home");
  await mkdir(home, { recursive: true });
  const settings = "agent-default-model:\n  provider: my-provider\n  model: web-model\nllm-pi-ai:\n  providers: {}\n";
  await writeFile(join(home, "settings.yaml"), settings);
  const result = await prepareDshLaunch(projectRoot, { qq: false });
  assert.equal(await readFile(join(home, "settings.yaml"), "utf8"), settings);
  const patch = await readFile(result.patchPath, "utf8");
  assert.doesNotMatch(patch, /id: llm-deepseek|id: llm-pi-ai|id: agent-default-model|plannerProvider|plannerModel/u);
  assert.match(patch, /id: reaper-mixing-agent/u);
});
