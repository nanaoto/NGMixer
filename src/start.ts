import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTerminalPrompter, ensureFirstRun } from "./first-run.js";

async function main(): Promise<number> {
  const projectRoot = process.cwd();
  const configPath = process.env.RMA_CONFIG_PATH ?? join(projectRoot, "config", "local.toml");
  const environmentPath = process.env.RMA_ENV_FILE ?? join(homedir(), ".config/reaper-mixing-agent/runtime.env");
  const firstRun = await ensureFirstRun({
    projectRoot,
    configPath,
    environmentPath,
    ...(process.stdin.isTTY && process.stdout.isTTY ? { prompter: createTerminalPrompter() } : {}),
  });
  if (firstRun.configured) {
    console.log(`首次配置完成。请在 REAPER Actions 中运行：${firstRun.bridgeLauncherPath}`);
    console.log(firstRun.channel === "qq"
      ? "QQ 通道已配置；DSH WebUI 也会同时启动。"
      : "未配置外部消息通道，正在启动本地 DSH WebUI。");
  }
  console.log("模型配置：打开网页的「设置 → 模型」，添加供应商和 API key，再选择默认模型。");
  const launchPath = fileURLToPath(new URL("./dsh/launch.js", import.meta.url));
  const child = spawn(process.execPath, [launchPath, ...process.argv.slice(2)], {
    cwd: projectRoot,
    env: { ...process.env, RMA_CONFIG_PATH: configPath, RMA_ENV_FILE: environmentPath },
    stdio: "inherit",
  });
  return await new Promise<number>((resolveChild, rejectChild) => {
    child.once("error", rejectChild);
    child.once("exit", (code) => resolveChild(code ?? 1));
  });
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
