import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import {
  initializeInstallation,
  type InstallationDependencies,
  type InstallationRequest,
  type OnboardingChannel,
} from "./onboarding.js";

export interface FirstRunPrompter {
  readonly write: (message: string) => void;
  readonly ask: (message: string, defaultValue?: string) => Promise<string>;
  readonly secret: (message: string) => Promise<string>;
  readonly confirm: (message: string, defaultValue: boolean) => Promise<boolean>;
  readonly choose: <T extends string>(message: string, choices: readonly T[], defaultIndex?: number) => Promise<T>;
}

export interface EnsureFirstRunOptions {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly environmentPath: string;
  readonly collect?: () => Promise<InstallationRequest>;
  readonly prompter?: FirstRunPrompter;
  readonly installationDependencies?: InstallationDependencies;
}

export interface FirstRunResult {
  readonly configured: boolean;
  readonly channel?: OnboardingChannel["kind"];
  readonly bridgeLauncherPath?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const details = await stat(path);
    await access(path, 1);
    return details.isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function absoluteInput(value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function splitList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

async function firstExisting(candidates: readonly string[], predicate = isExecutable): Promise<string> {
  for (const candidate of candidates) if (await predicate(candidate)) return candidate;
  return candidates[0] ?? "";
}

function pathExecutables(name: string): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((root) => join(root, name));
}

async function collectChannel(prompt: FirstRunPrompter): Promise<OnboardingChannel> {
  const kind = await prompt.choose("消息入口", ["web", "qq"] as const);
  if (kind === "web") return { kind: "web" };
  prompt.write("QQ 通道使用本机 QQ + NapCat/OneBot。请先完成 QQ 登录和 NapCat 安装；配置会以可重复方式写入。\n");
  return {
    kind: "qq",
    accountId: await prompt.ask("机器人 QQ 号"),
    groupId: await prompt.ask("默认结果群号"),
    groupIds: splitList(await prompt.ask("其他允许群号，逗号分隔（可空）", "")),
    privateUserIds: splitList(await prompt.ask("允许并信任的私聊 QQ 号，逗号分隔（可空）", "")),
  };
}

export async function collectTerminalInstallationRequest(options: {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly environmentPath: string;
  readonly homeDirectory?: string;
  readonly prompter: FirstRunPrompter;
}): Promise<InstallationRequest> {
  const home = options.homeDirectory ?? homedir();
  const prompt = options.prompter;
  prompt.write("\nNGMixer 首次配置\n模型供应商和 API key 稍后在网页「设置 → 模型」中配置。\n\n");
  const defaultReaper = await firstExisting([
    "/Applications/REAPER.app/Contents/MacOS/REAPER",
    "/Applications/REAPER64.app/Contents/MacOS/REAPER",
  ]);
  if (!await isExecutable(defaultReaper)) {
    prompt.write("尚未发现 REAPER。请从 https://www.reaper.fm/download.php 安装后输入可执行文件路径。\n");
  }
  const reaperExecutable = absoluteInput(await prompt.ask("REAPER 可执行文件", defaultReaper));
  const defaultFfmpeg = await firstExisting([
    ...pathExecutables("ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ]);
  if (!await isExecutable(defaultFfmpeg)) {
    prompt.write("尚未发现 FFmpeg。macOS 可先运行 `brew install ffmpeg`。\n");
  }
  const ffmpegExecutable = absoluteInput(await prompt.ask("FFmpeg 可执行文件", defaultFfmpeg));
  const reaperResourcePath = absoluteInput(await prompt.ask(
    "REAPER Resource 目录",
    join(home, "Library", "Application Support", "REAPER"),
  ));
  const runtimeRoot = absoluteInput(await prompt.ask(
    "运行状态目录",
    join(home, "Library", "Application Support", "REAPER Mixing Agent", "runtime"),
  ));
  const audioWorkRoot = absoluteInput(await prompt.ask(
    "工程、素材和渲染目录",
    join(home, "Music", "REAPER Mixing Agent"),
  ));
  const standardPluginRoots = [
    "/Library/Audio/Plug-Ins/VST",
    "/Library/Audio/Plug-Ins/VST3",
    "/Library/Audio/Plug-Ins/Components",
    "/Library/Audio/Plug-Ins/CLAP",
    join(home, "Library/Audio/Plug-Ins/VST"),
    join(home, "Library/Audio/Plug-Ins/VST3"),
    join(home, "Library/Audio/Plug-Ins/Components"),
    join(home, "Library/Audio/Plug-Ins/CLAP"),
  ];
  const detectedPluginRoots: string[] = [];
  for (const root of standardPluginRoots) if (await isDirectory(root)) detectedPluginRoots.push(root);
  const pluginRoots = splitList(await prompt.ask("插件扫描目录，逗号分隔", detectedPluginRoots.join(",")))
    .map(absoluteInput);
  const libraryRoots = splitList(await prompt.ask("音色库扫描目录，逗号分隔（可空）", ""))
    .map(absoluteInput);
  return {
    projectRoot: options.projectRoot,
    configPath: options.configPath,
    environmentPath: options.environmentPath,
    reaperExecutable,
    ffmpegExecutable,
    reaperResourcePath,
    runtimeRoot,
    audioWorkRoot,
    modelConfiguration: "dsh",
    providers: [],
    pluginRoots,
    libraryRoots,
    channel: await collectChannel(prompt),
  };
}

export async function ensureFirstRun(options: EnsureFirstRunOptions): Promise<FirstRunResult> {
  if (await exists(options.configPath)) return { configured: false };
  const collect = options.collect ?? (async () => {
    if (!options.prompter) throw new Error("first-run setup needs an interactive terminal");
    return collectTerminalInstallationRequest({
      projectRoot: options.projectRoot,
      configPath: options.configPath,
      environmentPath: options.environmentPath,
      prompter: options.prompter,
    });
  });
  const result = await initializeInstallation(await collect(), options.installationDependencies);
  return {
    configured: true,
    channel: result.channel,
    bridgeLauncherPath: result.bridgeLauncherPath,
  };
}

export function createTerminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): FirstRunPrompter {
  const ask = async (message: string, defaultValue?: string): Promise<string> => {
    const rl = createInterface({ input: input as Readable, output: output as Writable });
    try {
      const suffix = defaultValue === undefined || defaultValue === "" ? "" : ` [${defaultValue}]`;
      const answer = (await rl.question(`${message}${suffix}: `)).trim();
      return answer || defaultValue || "";
    } finally {
      rl.close();
    }
  };
  const confirm = async (message: string, defaultValue: boolean): Promise<boolean> => {
    const answer = (await ask(`${message} ${defaultValue ? "[Y/n]" : "[y/N]"}`)).toLocaleLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes" || answer === "是";
  };
  const choose = async <T extends string>(message: string, choices: readonly T[], defaultIndex = 0): Promise<T> => {
    output.write(`${message}:\n${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n")}\n`);
    for (;;) {
      const selected = Number.parseInt(await ask("选择", String(defaultIndex + 1)), 10) - 1;
      const choice = choices[selected];
      if (choice !== undefined) return choice;
      output.write("请输入列表中的序号。\n");
    }
  };
  const secret = async (message: string): Promise<string> => {
    if (!input.isTTY) return ask(message);
    output.write(`${message}: `);
    const previousRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    return new Promise<string>((resolveSecret, rejectSecret) => {
      let value = "";
      const finish = (error?: Error) => {
        input.off("data", onData);
        input.setRawMode(previousRaw);
        output.write("\n");
        if (error) rejectSecret(error);
        else resolveSecret(value);
      };
      const onData = (chunk: Buffer) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\r" || character === "\n") return finish();
          if (character === "\u0003") return finish(new Error("first-run setup cancelled"));
          if (character === "\u007f" || character === "\b") {
            if (value) {
              value = value.slice(0, -1);
              output.write("\b \b");
            }
          } else {
            value += character;
            output.write("*");
          }
        }
      };
      input.on("data", onData);
    });
  };
  return { write: (message) => output.write(message), ask, secret, confirm, choose };
}
