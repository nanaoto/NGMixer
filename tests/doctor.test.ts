import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDoctor } from "../src/doctor.js";
import { writeConfig } from "./helpers.js";

test("doctor passes a keyless config with writable parents under supported Node", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-doctor-"));
  const configPath = await writeConfig(directory);

  const report = await runDoctor(configPath, { keyless: true, nodeVersion: "v22.19.0" });

  assert.equal(report.ok, true);
  assert.ok(report.lines.some((line) => line.includes("PASS config")));
  assert.ok(report.lines.some((line) => line.includes("PASS runtime_root")));
  assert.ok(report.lines.some((line) => line.includes("PASS Node v22.19.0")));
  assert.ok(report.lines.some((line) => line.startsWith("PASS installed DSH 0.1.0-rc.")));
  assert.equal(report.lines.some((line) => line.includes("expected DSH")), false);
  assert.ok(report.lines.some((line) => line.includes("Cordis 4.0.1")));
});

test("doctor rejects installed DSH contracts and Cordis outside the declared ranges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-doctor-"));
  const configPath = await writeConfig(directory);
  const installedVersions: Readonly<Record<string, string>> = {
    "@deepseek-ai/dsh": "0.1.0-rc.7",
    "@deepseek-ai/dsh-agent": "0.1.0-rc.8",
    "@deepseek-ai/dsh-agent-presets": "0.1.0-rc.8",
    "@deepseek-ai/dsh-permission-presets": "0.1.0-rc.8",
    "@deepseek-ai/dsh-llm": "0.1.0-rc.8",
    "@deepseek-ai/dsh-mcp-client": "0.1.0-rc.8",
    "@deepseek-ai/dsh-session": "0.1.0-rc.8",
    "@deepseek-ai/dsh-tools": "0.1.0-rc.8",
    "@deepseek-ai/cordis": "4.1.0",
  };

  const report = await runDoctor(configPath, {
    keyless: true,
    nodeVersion: "v22.19.0",
    resolvePackageVersion: async (packageName) => {
      const version = installedVersions[packageName];
      if (!version) throw new Error(`missing test version for ${packageName}`);
      return version;
    },
  });

  assert.equal(report.ok, false);
  assert.ok(report.lines.includes("FAIL installed DSH 0.1.0-rc.7 does not satisfy ^0.1.0-rc.8"));
  assert.ok(report.lines.includes("FAIL installed Cordis 4.1.0 does not satisfy 4.0.1"));
});

test("doctor reports Node 25 as a clear failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-doctor-"));
  const configPath = await writeConfig(directory);

  const report = await runDoctor(configPath, { keyless: true, nodeVersion: "v25.8.0" });

  assert.equal(report.ok, false);
  assert.ok(report.lines.some((line) => line.includes("FAIL Node v25.8.0; expected >=22.19 <23")));
});

test("doctor checks the nearest existing parent without creating target roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-doctor-"));
  const readOnlyParent = join(directory, "not-a-directory");
  await mkdir(readOnlyParent);
  const configPath = await writeConfig(directory, {
    runtimeRoot: join(readOnlyParent, "missing", "runtime"),
  });

  const report = await runDoctor(configPath, { keyless: true, nodeVersion: "v22.19.0" });

  assert.equal(report.lines.some((line) => line.includes(`PASS runtime_root parent ${readOnlyParent}`)), true);
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(join(readOnlyParent, "missing")));
});

test("doctor checks every distinct DSH provider credential outside keyless mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rma-doctor-"));
  const chatSecret = "RMA_DOCTOR_CHAT_SECRET";
  const mixSecret = "RMA_DOCTOR_MIX_SECRET";
  const configPath = await writeConfig(directory, { apiKeyEnv: chatSecret });
  const singleRoute = await readFile(configPath, "utf8");
  await writeFile(configPath, `${singleRoute.replace(
    '[llm.mix_planner]\nprovider = "primary"\nmodel = "test-model"',
    '[llm.mix_planner]\nprovider = "mix-planner"\nmodel = "mix-model"',
  )}\n[llm.providers.mix-planner]\napi = "openai-completions"\nbase_url = "https://mix.example.invalid/v1"\napi_key_env = "${mixSecret}"\n\n[[llm.providers.mix-planner.models]]\nid = "mix-model"\n`);
  delete process.env[chatSecret];
  delete process.env[mixSecret];

  const missing = await runDoctor(configPath, { keyless: false, nodeVersion: "v22.19.0" });
  assert.equal(missing.ok, false);
  assert.ok(missing.lines.some((line) => line === `FAIL provider credential environment variable ${chatSecret} is not set`));
  assert.ok(missing.lines.some((line) => line === `FAIL provider credential environment variable ${mixSecret} is not set`));

  process.env[chatSecret] = "never-print-this";
  process.env[mixSecret] = "also-never-print-this";
  const present = await runDoctor(configPath, { keyless: false, nodeVersion: "v22.19.0" });
  assert.equal(present.ok, true);
  assert.equal(present.lines.join("\n").includes("never-print-this"), false);
  delete process.env[chatSecret];
  delete process.env[mixSecret];
});
