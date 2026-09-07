import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";
import { writeConfig } from "./helpers.js";

test("loads the local.example.toml shape without reading the secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-config-"));
  const configPath = await writeConfig(directory);
  process.env.RMA_TEST_KEY = "must-not-be-read";

  const config = await loadConfig(configPath);
  assert.ok(config.llm);

  assert.equal(config.paths.runtimeRoot, join(directory, "runtime"));
  assert.equal(config.paths.ffmpegExecutable, "/opt/homebrew/bin/ffmpeg");
  assert.equal(config.llm.providers.primary?.apiKeyEnv, "RMA_TEST_KEY");
  assert.equal(JSON.stringify(config).includes("must-not-be-read"), false);
});

test("loads independent DSH provider routes and model selections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-config-"));
  const configPath = await writeConfig(directory);
  const singleRoute = await readFile(configPath, "utf8");
  await writeFile(configPath, singleRoute
    .replace(
      'provider = "primary"\nmodel = "test-model"',
      'provider = "chat-main"\nmodel = "chat-model"\nfallbacks = [{ provider = "chat-backup", model = "chat-model" }]',
    )
    .replace('provider = "primary"\nmodel = "test-model"', 'provider = "mix-planner"\nmodel = "planner-model"')
    .replace(
      /\[llm\.providers\.primary\][\s\S]*?id = "test-model"/u,
      `[llm.providers.chat-main]\ndisplay_name = "Chat Main"\napi = "openai-responses"\nbase_url = "https://chat.example.invalid/v1"\napi_key_env = "CHAT_TEST_KEY"\n\n[[llm.providers.chat-main.models]]\nid = "chat-model"\ncontext_window = 131072\nmax_tokens = 8192\n\n[llm.providers.chat-backup]\napi = "openai-responses"\nbase_url = "https://backup.example.invalid/v1"\napi_key_env = "CHAT_BACKUP_TEST_KEY"\n\n[[llm.providers.chat-backup.models]]\nid = "chat-model"\n\n[llm.providers.mix-planner]\napi = "openai-completions"\nbase_url = "https://mix.example.invalid/v1"\napi_key_env = "MIX_TEST_KEY"\n\n[[llm.providers.mix-planner.models]]\nid = "planner-model"`,
    ));

  const config = await loadConfig(configPath);
  assert.ok(config.llm);

  assert.deepEqual(config.llm.default, {
    provider: "chat-main",
    model: "chat-model",
    fallbacks: [{ provider: "chat-backup", model: "chat-model" }],
  });
  assert.deepEqual(config.llm.mixPlanner, { provider: "mix-planner", model: "planner-model" });
  assert.deepEqual(config.llm.providers["chat-main"]?.models, [
    { id: "chat-model", contextWindow: 131072, maxTokens: 8192 },
  ]);
  assert.equal(config.llm.providers["mix-planner"]?.baseUrl, "https://mix.example.invalid/v1");
});

test("rejects relative machine paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-config-"));
  const configPath = await writeConfig(directory);
  const text = await import("node:fs/promises").then((fs) => fs.readFile(configPath, "utf8"));
  await writeFile(configPath, text.replace(`${directory}/runtime`, "relative/runtime"));

  await assert.rejects(loadConfig(configPath), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /paths\.runtime_root/);
    return true;
  });
});

test("rejects non-literal loopback hosts and unsafe booleans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-config-"));
  const configPath = await writeConfig(directory);
  const text = await import("node:fs/promises").then((fs) => fs.readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    text
      .replace('daemon_host = "127.0.0.1"', 'daemon_host = "127.0.0.2"')
      .replace("allow_source_media_write = false", "allow_source_media_write = true"),
  );

  await assert.rejects(loadConfig(configPath), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /network\.daemon_host/);
    assert.match(error.message, /safety\.allow_source_media_write/);
    return true;
  });
});

test("rejects invalid provider environment variable names without echoing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-config-"));
  const invalidName = "SECRET=value-that-must-not-leak";
  const configPath = await writeConfig(directory, { apiKeyEnv: invalidName });

  await assert.rejects(loadConfig(configPath), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /llm\.providers\.primary\.api_key_env/);
    assert.equal(error.message.includes(invalidName), false);
    return true;
  });
});

test("rejects provider credentials that collide with managed QQ runtime variables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-config-"));
  const configPath = await writeConfig(directory, { apiKeyEnv: "RMA_QQ_GROUP_ID" });

  await assert.rejects(loadConfig(configPath), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /llm\.providers\.primary\.api_key_env: conflicts with a managed runtime variable/u);
    return true;
  });
});
