#!/usr/bin/env node

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = process.cwd();
const requiredLocalTools = ["dsh", "tsc", "tsx"];
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
if (nodeMajor !== 22 || nodeMinor < 19) {
  throw new Error(`需要 Node >=22.19 <23，当前是 ${process.versions.node}`);
}

async function localToolExists(name) {
  const executable = join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  try {
    await access(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

if (!(await Promise.all(requiredLocalTools.map(localToolExists))).every(Boolean)) {
  console.log("本地 DSH/构建依赖尚未安装，正在按 pnpm-lock.yaml 自动安装……");
  const result = spawnSync("corepack", ["pnpm", "install", "--frozen-lockfile"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
