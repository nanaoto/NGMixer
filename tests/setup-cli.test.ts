import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";

test("setup creates a private, usable local config and refuses to overwrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-setup-"));
  const reaperExecutable = join(root, "REAPER");
  const ffmpegExecutable = join(root, "ffmpeg");
  const reaperResourcePath = join(root, "reaper-resource");
  const runtimeRoot = join(root, "runtime");
  const audioWorkRoot = join(root, "audio-work");
  const configPath = join(root, "config", "local.toml");
  await mkdir(reaperResourcePath, { recursive: true });
  await writeFile(reaperExecutable, "fake executable\n", { mode: 0o700 });
  await writeFile(ffmpegExecutable, "fake executable\n", { mode: 0o700 });
  const output: string[] = [];
  const argv = [
    "node", "mixing-agent", "setup",
    "--config", configPath,
    "--base-url", "https://provider.example/v1",
    "--model", "example-model",
    "--api-key-env", "RMA_EXAMPLE_API_KEY",
    "--reaper-executable", reaperExecutable,
    "--ffmpeg-executable", ffmpegExecutable,
    "--reaper-resource-path", reaperResourcePath,
    "--runtime-root", runtimeRoot,
    "--audio-work-root", audioWorkRoot,
  ];

  assert.equal(await runCli(argv, { write: (line) => output.push(line) }), 0);
  const config = await loadConfig(configPath);
  assert.ok(config.llm);
  assert.equal(config.paths.runtimeRoot, runtimeRoot);
  assert.equal(config.llm.default.model, "example-model");
  assert.equal(config.llm.providers.primary?.apiKeyEnv, "RMA_EXAMPLE_API_KEY");
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(runtimeRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(audioWorkRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(runtimeRoot)).isDirectory(), true);
  assert.equal((await stat(audioWorkRoot)).isDirectory(), true);
  assert.match(output.join("\n"), /config\/local\.toml|local\.toml/u);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /sk-|secret|token/iu);

  const original = await readFile(configPath, "utf8");
  assert.equal(await runCli(argv, { write: (line) => output.push(line) }), 1);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.match(output.at(-1) ?? "", /already exists/u);
});

test("setup rejects a provider URL that could persist credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-setup-secret-url-"));
  const output: string[] = [];
  const exitCode = await runCli([
    "node", "mixing-agent", "setup",
    "--config", join(root, "local.toml"),
    "--base-url", "https://user:password@provider.example/v1?api_key=leak",
    "--model", "example-model",
  ], { write: (line) => output.push(line) });

  assert.equal(exitCode, 1);
  assert.match(output.join("\n"), /must not include credentials, query parameters, or fragments/u);
  assert.doesNotMatch(output.join("\n"), /password|api_key|leak/u);
});
