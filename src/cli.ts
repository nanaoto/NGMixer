#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { readBridgeStatuses } from "./bridge/heartbeat.js";
import { installBridge } from "./bridge/install.js";
import type { BridgeOperation, JsonValue } from "./bridge/protocol.js";
import { BridgeSpool } from "./bridge/spool.js";
import { scanStudioInventory } from "./catalog/inventory.js";
import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { loadRuntimeEnvironment } from "./runtime/environment.js";
import { setupLocalProject, type ProviderApi } from "./setup.js";
import { EventLedger } from "./ledger/event-store.js";
import { effectChainTemplates, vocalMixProject } from "./mixing/blueprints.js";
import { JsonlCommunicationJournal } from "./communication/napcat-module.js";
import { OneBotHttpGateway, normalizeOneBotGroupMessage } from "./qq/onebot.js";
import { bootstrapNapCatMacos, installFfmpegBridgeMacos } from "./qq/napcat-bootstrap.js";

export interface CliDependencies {
  readonly nodeVersion?: string;
  readonly bridgeSourcePath?: string;
  readonly renderWorkerSourcePath?: string;
  readonly fetcher?: typeof fetch;
  readonly write?: (line: string) => void;
  readonly bootstrapNapCat?: typeof bootstrapNapCatMacos;
}

function localNapCatUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error("NapCat HTTP server must use a loopback http URL");
  }
  return url.toString().replace(/\/$/, "");
}

function requiredCredential(environmentName: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
    throw new Error(`${label} environment variable name is invalid`);
  }
  const value = process.env[environmentName];
  if (!value) throw new Error(`${label} credential ${environmentName} is missing`);
  return value;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const write = dependencies.write ?? console.log;
  const program = new Command();
  let exitCode = 0;
  program.name("mixing-agent").description("NGMixer deterministic REAPER runtime");
  program.exitOverride();

  program
    .command("setup")
    .description("Create a private local config with detected macOS paths")
    .option("--config <path>", "local TOML configuration to create", "config/local.toml")
    .requiredOption("--base-url <url>", "OpenAI/Anthropic-compatible provider base URL")
    .requiredOption("--model <id>", "model id used for chat and mix planning")
    .option("--api-key-env <name>", "environment variable containing the provider key", "REAPER_MIXING_AGENT_API_KEY")
    .option("--provider <name>", "DSH provider route name", "primary")
    .option("--provider-api <api>", "openai-completions, openai-responses, or anthropic-messages", "openai-completions")
    .option("--reaper-executable <path>", "absolute REAPER executable path")
    .option("--ffmpeg-executable <path>", "absolute FFmpeg executable path")
    .option("--reaper-resource-path <path>", "absolute REAPER resource directory")
    .option("--runtime-root <path>", "private runtime state directory")
    .option("--audio-work-root <path>", "private projects and audio directory")
    .action(async (options: {
      config: string;
      baseUrl: string;
      model: string;
      apiKeyEnv: string;
      provider: string;
      providerApi: string;
      reaperExecutable?: string;
      ffmpegExecutable?: string;
      reaperResourcePath?: string;
      runtimeRoot?: string;
      audioWorkRoot?: string;
    }) => {
      if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(options.providerApi)) {
        throw new Error("provider API must be openai-completions, openai-responses, or anthropic-messages");
      }
      const report = await setupLocalProject({
        configPath: options.config,
        baseUrl: options.baseUrl,
        model: options.model,
        apiKeyEnv: options.apiKeyEnv,
        provider: options.provider,
        providerApi: options.providerApi as ProviderApi,
        ...(options.reaperExecutable ? { reaperExecutable: options.reaperExecutable } : {}),
        ...(options.ffmpegExecutable ? { ffmpegExecutable: options.ffmpegExecutable } : {}),
        ...(options.reaperResourcePath ? { reaperResourcePath: options.reaperResourcePath } : {}),
        ...(options.runtimeRoot ? { runtimeRoot: options.runtimeRoot } : {}),
        ...(options.audioWorkRoot ? { audioWorkRoot: options.audioWorkRoot } : {}),
      });
      write(JSON.stringify({
        status: "configured",
        ...report,
        next: [
          `Store ${report.apiKeyEnvs.join(", ")} in a chmod 0600 runtime.env file`,
          `node --import tsx src/cli.ts doctor --config ${JSON.stringify(report.configPath)}`,
          `node --import tsx src/cli.ts bridge install --config ${JSON.stringify(report.configPath)} --bridge-instance main`,
        ],
      }, null, 2));
    });

  program
    .command("doctor")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .option("--keyless", "skip the provider credential presence check", false)
    .action(async (options: { config: string; keyless: boolean }) => {
      const report = await runDoctor(options.config, {
        keyless: options.keyless,
        ...(dependencies.nodeVersion === undefined ? {} : { nodeVersion: dependencies.nodeVersion }),
      });
      for (const line of report.lines) write(line);
      exitCode = report.ok ? 0 : 1;
    });

  const bridge = program.command("bridge").description("Inspect or request the REAPER bridge");
  bridge
    .command("install")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--bridge-instance <id>", "bridge instance id")
    .action(async (options: { config: string; bridgeInstance: string }) => {
      const config = await loadConfig(options.config);
      const sourcePath =
        dependencies.bridgeSourcePath ??
        fileURLToPath(new URL("../reaper/MixingAgentBridge.lua", import.meta.url));
      const workerSourcePath =
        dependencies.renderWorkerSourcePath ??
        fileURLToPath(new URL("../reaper/RenderWorker.lua", import.meta.url));
      write(
        JSON.stringify(
          await installBridge({
            reaperResourcePath: config.paths.reaperResourcePath,
            runtimeRoot: config.paths.runtimeRoot,
            audioWorkRoot: config.paths.audioWorkRoot,
            bridgeInstanceId: options.bridgeInstance,
            sourcePath,
            workerSourcePath,
          }),
          null,
          2,
        ),
      );
    });

  bridge
    .command("status")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .action(async (options: { config: string }) => {
      const config = await loadConfig(options.config);
      write(JSON.stringify(await readBridgeStatuses(config.paths.runtimeRoot), null, 2));
    });

  bridge
    .command("request")
    .argument("<request>", "health or snapshot")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--bridge-instance <id>", "bridge instance id")
    .option("--timeout-ms <milliseconds>", "receipt timeout", (value) => Number.parseInt(value, 10))
    .action(
      async (
        request: string,
        options: { config: string; bridgeInstance: string; timeoutMs?: number },
      ) => {
        const operationByRequest: Record<string, BridgeOperation> = {
          health: "bridge.health",
          snapshot: "project.snapshot",
        };
        const operation = operationByRequest[request];
        if (!operation) throw new Error("request must be health or snapshot");
        const config = await loadConfig(options.config);
        const timeoutMs = options.timeoutMs ?? config.reaper.commandTimeoutMs;
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeout must be a positive integer");
        const spool = new BridgeSpool(config.paths.runtimeRoot, options.bridgeInstance, {
          pollIntervalMs: config.reaper.pollIntervalMs,
        });
        const command = await spool.submitCommand({
          sessionId: randomUUID(),
          operation,
          timeoutMs,
          payload: {},
        });
        write(JSON.stringify(await spool.waitForReceipt(command.command_id, timeoutMs), null, 2));
      },
    );

  const catalog = program.command("catalog").description("Scan local studio assets");
  catalog
    .command("scan")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--output <path>", "inventory JSON output path")
    .option("--plugin-root <path...>", "plug-in bundle roots")
    .option("--library-root <path...>", "sound library roots")
    .action(async (options: { config: string; output: string; pluginRoot?: string[]; libraryRoot?: string[] }) => {
      const config = await loadConfig(options.config);
      const inventory = await scanStudioInventory({
        reaperResourcePath: config.paths.reaperResourcePath,
        pluginRoots: options.pluginRoot ?? [],
        libraryRoots: options.libraryRoot ?? [],
      });
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
      write(JSON.stringify({
        output: options.output,
        reaperPluginsRecognized: inventory.reaperPlugins.filter((plugin) => plugin.status === "recognized").length,
        reaperPluginsFailed: inventory.reaperPlugins.filter((plugin) => plugin.status === "failed").length,
        pluginBundles: inventory.pluginBundles.length,
        soundLibraries: inventory.soundLibraries.length,
      }, null, 2));
    });

  program
    .command("templates")
    .description("List usable effect-chain templates")
    .option("--scope <scope>", "vocal or master")
    .action((options: { scope?: string }) => {
      if (options.scope && options.scope !== "vocal" && options.scope !== "master") {
        throw new Error("scope must be vocal or master");
      }
      write(JSON.stringify(
        effectChainTemplates.filter((template) => !options.scope || template.scope === options.scope),
        null,
        2,
      ));
    });

  const project = program.command("project").description("Build a REAPER project from a known blueprint");
  project.command("bootstrap")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--bridge-instance <id>", "bridge instance id")
    .option("--timeout-ms <milliseconds>", "receipt timeout", (value) => Number.parseInt(value, 10))
    .action(async (options: { config: string; bridgeInstance: string; timeoutMs?: number }) => {
      const config = await loadConfig(options.config);
      const timeoutMs = options.timeoutMs ?? config.reaper.commandTimeoutMs;
      const spool = new BridgeSpool(config.paths.runtimeRoot, options.bridgeInstance, {
        pollIntervalMs: config.reaper.pollIntervalMs,
      });
      const command = await spool.submitCommand({
        sessionId: randomUUID(),
        operation: "project.bootstrap",
        timeoutMs,
        payload: vocalMixProject as unknown as JsonValue,
      });
      write(JSON.stringify(await spool.waitForReceipt(command.command_id, timeoutMs), null, 2));
    });

  const qq = program.command("qq").description("QQ ingress and iteration utilities");
  qq.command("install-ffmpeg-bridge-macos")
    .description("Install the authenticated media bridge without reading QQ account or group configuration")
    .option("--no-reload-launch-agent", "write but do not reload the FFmpeg LaunchAgent")
    .action(async (options: { reloadLaunchAgent: boolean }) => {
      const report = await installFfmpegBridgeMacos({
        projectRoot: process.cwd(),
        reloadLaunchAgent: options.reloadLaunchAgent,
      });
      write(JSON.stringify({ status: "installed", ...report }, null, 2));
    });
  qq.command("repair-macos")
    .description("Re-inject NapCat and install the authenticated FFmpeg bridge without requiring QQ scopes")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--qq-account-id <id>", "personal QQ account logged into NapCat")
    .option("--no-reload-launch-agent", "write but do not reload the FFmpeg LaunchAgent")
    .action(async (options: { config: string; qqAccountId: string; reloadLaunchAgent: boolean }) => {
      const config = await loadConfig(options.config);
      const report = await (dependencies.bootstrapNapCat ?? bootstrapNapCatMacos)({
        projectRoot: process.cwd(),
        accountId: options.qqAccountId,
        eventPort: config.network.daemonPort,
        reloadLaunchAgent: options.reloadLaunchAgent,
      });
      write(JSON.stringify({ status: "repaired", ...report }, null, 2));
    });
  qq.command("bootstrap-macos")
    .description("Idempotently configure QQ/NapCat, OneBot, and the authenticated FFmpeg bridge")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--qq-account-id <id>", "personal QQ account logged into NapCat")
    .requiredOption("--qq-group-id <id>", "default QQ result group")
    .option("--allow-group-id <id...>", "additional QQ group whitelist")
    .option("--private-user-id <id...>", "QQ users allowed to private-message the agent")
    .option("--env-file <path>", "private runtime environment file")
    .option("--no-reload-launch-agent", "write but do not reload the FFmpeg LaunchAgent")
    .action(async (options: {
      config: string;
      qqAccountId: string;
      qqGroupId: string;
      allowGroupId?: string[];
      privateUserId?: string[];
      envFile?: string;
      reloadLaunchAgent: boolean;
    }) => {
      const config = await loadConfig(options.config);
      const report = await (dependencies.bootstrapNapCat ?? bootstrapNapCatMacos)({
        projectRoot: process.cwd(),
        accountId: options.qqAccountId,
        groupId: options.qqGroupId,
        eventPort: config.network.daemonPort,
        ...(options.allowGroupId ? { groupIds: options.allowGroupId } : {}),
        ...(options.privateUserId ? { privateUserIds: options.privateUserId } : {}),
        providerApiKeyEnvs: [...new Set(
          Object.values(config.llm?.providers ?? {}).map((provider) => provider.apiKeyEnv),
        )].sort(),
        ...(options.envFile ? { runtimeEnvironmentPath: options.envFile } : {}),
        reloadLaunchAgent: options.reloadLaunchAgent,
      });
      write(JSON.stringify({ status: "configured", ...report }, null, 2));
    });
  qq.command("napcat-doctor")
    .description("Verify the local NapCat personal QQ account and target group")
    .requiredOption("--napcat-url <url>", "loopback NapCat OneBot HTTP server")
    .requiredOption("--napcat-token-env <name>", "environment variable containing the shared NapCat token")
    .requiredOption("--qq-account-id <id>", "personal QQ account logged into NapCat")
    .requiredOption("--qq-group-id <id>", "single QQ feedback group")
    .action(async (options: {
      napcatUrl: string;
      napcatTokenEnv: string;
      qqAccountId: string;
      qqGroupId: string;
    }) => {
      const gateway = new OneBotHttpGateway(
        localNapCatUrl(options.napcatUrl),
        dependencies.fetcher ?? fetch,
        requiredCredential(options.napcatTokenEnv, "NapCat"),
      );
      const account = await gateway.verifyPersonalAccount({
        accountId: options.qqAccountId,
        groupId: options.qqGroupId,
      });
      write(JSON.stringify({
        status: "ready",
        accountId: account.accountId,
        nickname: account.nickname,
        groupId: account.groupId,
        groupName: account.groupName,
      }, null, 2));
    });
  qq.command("reconcile-delivery")
    .description("Resolve a NapCat send whose external result was uncertain")
    .requiredOption("--config <path>", "path to local TOML configuration")
    .requiredOption("--qq-account-id <id>", "personal QQ account that attempted the send")
    .requiredOption("--qq-group-id <id>", "QQ feedback group that received or rejected the send")
    .requiredOption("--delivery-id <id>", "delivery id from the attempting ledger event")
    .requiredOption("--outcome <outcome>", "delivered or abandoned")
    .option("--message-id <id>", "actual QQ message id; required for delivered")
    .action(async (options: {
      config: string;
      qqAccountId: string;
      qqGroupId: string;
      deliveryId: string;
      outcome: string;
      messageId?: string;
    }) => {
      if (options.outcome !== "delivered" && options.outcome !== "abandoned") {
        throw new Error("delivery outcome must be delivered or abandoned");
      }
      const config = await loadConfig(options.config);
      const journal = new JsonlCommunicationJournal(join(
        config.paths.runtimeRoot,
        "communication",
        "qq",
        `${options.qqAccountId}.jsonl`,
      ));
      const receipt = await journal.reconcileDelivery({
        deliveryId: options.deliveryId,
        accountId: options.qqAccountId,
        groupId: options.qqGroupId,
        outcome: options.outcome,
        ...(options.messageId ? { platformMessageId: options.messageId } : {}),
      });
      write(JSON.stringify({
        status: "reconciled",
        receipt,
      }, null, 2));
    });
  qq.command("ingest-onebot")
    .requiredOption("--event <path>", "OneBot event JSON")
    .requiredOption("--ledger <path>", "session event JSONL")
    .requiredOption("--session-id <id>", "mixing session id")
    .requiredOption("--iteration <number>", "iteration number", (value) => Number.parseInt(value, 10))
    .action(async (options: { event: string; ledger: string; sessionId: string; iteration: number }) => {
      const message = normalizeOneBotGroupMessage(JSON.parse(await readFile(options.event, "utf8")) as unknown);
      const ledger = new EventLedger(options.ledger);
      const event = await ledger.append({
        eventId: `qq-${message.messageId}`,
        sessionId: options.sessionId,
        iteration: options.iteration,
        kind: options.iteration === 0 ? "communication.received" : "feedback.received",
        actor: { platform: "qq", id: message.senderId, displayName: message.senderName },
        payload: message,
        training: { use: "unknown", contentClass: "group-message" },
      });
      write(JSON.stringify(event, null, 2));
    });

  try {
    await program.parseAsync([...argv], { from: "node" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    write(`FAIL ${error instanceof Error ? error.message : "unexpected error"}`);
    return 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  await loadRuntimeEnvironment(
    process.env.RMA_ENV_FILE ?? join(homedir(), ".config/reaper-mixing-agent/runtime.env"),
  );
  process.exitCode = await runCli(process.argv);
}
