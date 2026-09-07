import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  bootstrapNapCatMacos,
  mergeOneBotConfig,
  patchNapCatFfmpegBridge,
  renderFfmpegLaunchAgent,
  renderRuntimeEnvironment,
} from "../src/qq/napcat-bootstrap.js";

test("NapCat bootstrap preserves unrelated OneBot endpoints and replaces its own endpoints", () => {
  const merged = mergeOneBotConfig({
    network: {
      httpServers: [{ name: "other", enable: true, port: 4000 }],
      httpClients: [{ name: "old", enable: true, url: "http://127.0.0.1:9999" }],
      websocketServers: [], websocketClients: [], httpSseServers: [], plugins: [],
    },
  }, { token: "secret", apiPort: 3000, eventPort: 32180 });
  const network = (merged.network ?? {}) as Record<string, unknown>;
  assert.equal((network.httpServers as unknown[]).length, 2);
  assert.equal((network.httpClients as unknown[]).length, 2);
  assert.match(JSON.stringify(merged), /mixing-agent-api/u);
  assert.match(JSON.stringify(merged), /mixing-agent-events/u);
});

test("NapCat FFmpeg patch adds bearer authentication and is idempotent", () => {
  const source = [
    "const Rc = $L(jL);",
    "function jv(t) {",
    "  return t;",
    "}",
  ].join("\n");
  const patched = patchNapCatFfmpegBridge(source, {
    endpoint: "http://127.0.0.1:32281/exec",
    tokenFile: "/tmp/napcat/ffmpeg.token",
  });
  assert.match(patched, /RMA_AUTHENTICATED_FFMPEG_BRIDGE/u);
  assert.match(patched, /authorization: `Bearer \$\{i\}`/u);
  assert.equal(patchNapCatFfmpegBridge(patched, {
    endpoint: "http://127.0.0.1:32281/exec",
    tokenFile: "/tmp/napcat/ffmpeg.token",
  }), patched);
});

test("runtime environment renderer records QQ scopes but never the provider secret value", () => {
  const rendered = renderRuntimeEnvironment({
    napCatToken: "onebot-secret",
    accountId: "42",
    groupId: "314",
    outboundStagingRoot: "/qq-data/Documents/napcat/rma-outbound",
    privateUserIds: ["7"],
    providerCredentials: {
      CHAT_API_KEY: "",
      MIX_API_KEY: "",
    },
  });
  assert.match(rendered, /NAPCAT_ONEBOT_TOKEN=onebot-secret/u);
  assert.match(rendered, /RMA_QQ_PRIVATE_USER_IDS=7/u);
  assert.match(rendered, /RMA_QQ_OUTBOUND_STAGING_ROOT=\/qq-data\/Documents\/napcat\/rma-outbound/u);
  assert.match(rendered, /CHAT_API_KEY=\n/u);
  assert.match(rendered, /MIX_API_KEY=\n/u);
  assert.match(renderFfmpegLaunchAgent({
    nodePath: "/node", scriptPath: "/bridge.mjs", tokenFile: "/token",
    allowedRoot: "/qq", logPath: "/log", port: 32281,
  }), /RMA_FFMPEG_BRIDGE_AUTOSTART/u);
});

test("macOS bootstrap is repeatable across QQ updates without duplicating managed endpoints", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS-only bootstrap");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rma-napcat-bootstrap-"));
  const projectRoot = join(root, "project");
  const realQqAppPath = join(root, "mounted/Applications/QQ.app");
  const qqAppPath = join(root, "Applications/QQ.app");
  const qqDataRoot = join(root, "QQData");
  const packagePath = join(realQqAppPath, "Contents/Resources/app/package.json");
  const configRoot = join(qqDataRoot, "Library/Application Support/QQ/NapCat/config");
  const napCatRoot = join(qqDataRoot, "Documents/napcat");
  await Promise.all([
    mkdir(dirname(qqAppPath), { recursive: true }),
    mkdir(join(realQqAppPath, "Contents/Resources/app/app_launcher"), { recursive: true }),
  ]);
  await symlink(realQqAppPath, qqAppPath);
  await Promise.all([
    mkdir(join(projectRoot, "dist/qq"), { recursive: true }),
    mkdir(configRoot, { recursive: true }),
    mkdir(napCatRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(projectRoot, "dist/qq/ffmpeg-bridge.js"), "console.log('bridge');\n"),
    writeFile(packagePath, JSON.stringify({ buildVersion: "49738", main: "app_launcher/index.js" })),
    writeFile(join(qqDataRoot, "Documents/loadNapCat.js"), "// old loader\n"),
    writeFile(join(napCatRoot, "napcat.mjs"), "const Rc = $L(jL);\nfunction jv(t) { return t; }\n"),
    writeFile(join(configRoot, "onebot11_123456.json"), JSON.stringify({ network: {} })),
    writeFile(join(configRoot, "napcat_123456.json"), JSON.stringify({ packetBackend: "auto" })),
  ]);
  const repairOptions = {
    projectRoot, accountId: "123456",
    eventPort: 32180, qqAppPath, qqDataRoot,
    runtimeEnvironmentPath: join(root, "runtime.env"),
    launchAgentPath: join(root, "bridge.plist"),
    applicationSupportPath: join(root, "Application Support"),
    reloadLaunchAgent: false,
  } as const;
  const options = {
    ...repairOptions,
    groupId: "234567",
    privateUserIds: ["345678"],
  } as const;

  const repair = await bootstrapNapCatMacos(repairOptions);
  assert.equal(repair.oneBotConfigPath, undefined);
  await bootstrapNapCatMacos(options);
  await bootstrapNapCatMacos(options);

  const source = await readFile(join(napCatRoot, "napcat.mjs"), "utf8");
  assert.equal(source.match(/RMA_AUTHENTICATED_FFMPEG_BRIDGE/gu)?.length, 1);
  const oneBot = await readFile(join(configRoot, "onebot11_123456.json"), "utf8");
  assert.equal(oneBot.match(/mixing-agent-api/gu)?.length, 1);
  assert.equal((await stat(join(root, "runtime.env"))).mode & 0o777, 0o600);
  const napCatBridgeToken = await readFile(join(napCatRoot, "ffmpeg-bridge.token"), "utf8");
  const launchAgentBridgeToken = await readFile(
    join(root, "Application Support/ffmpeg-bridge.token"),
    "utf8",
  );
  assert.equal(napCatBridgeToken, launchAgentBridgeToken);
  assert.match(
    await readFile(join(root, "bridge.plist"), "utf8"),
    /Application Support\/ffmpeg-bridge\.token/u,
  );
  const qqPackage = JSON.parse(await readFile(packagePath, "utf8")) as { main: string };
  assert.match(qqPackage.main, /loadNapCat\.js/u);
  assert.equal(
    resolve(dirname(await realpath(packagePath)), qqPackage.main),
    await realpath(join(qqDataRoot, "Documents/loadNapCat.js")),
  );
});

test("macOS bootstrap performs no managed writes when an upstream patch seam is unknown", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS-only bootstrap");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rma-napcat-preflight-"));
  const projectRoot = join(root, "project");
  const qqAppPath = join(root, "QQ.app");
  const qqDataRoot = join(root, "QQData");
  const packagePath = join(qqAppPath, "Contents/Resources/app/package.json");
  const configRoot = join(qqDataRoot, "Library/Application Support/QQ/NapCat/config");
  const napCatRoot = join(qqDataRoot, "Documents/napcat");
  await Promise.all([
    mkdir(join(projectRoot, "dist/qq"), { recursive: true }),
    mkdir(join(qqAppPath, "Contents/Resources/app"), { recursive: true }),
    mkdir(configRoot, { recursive: true }), mkdir(napCatRoot, { recursive: true }),
  ]);
  const oneBotPath = join(configRoot, "onebot11_123456.json");
  const napCatConfigPath = join(configRoot, "napcat_123456.json");
  await Promise.all([
    writeFile(join(projectRoot, "dist/qq/ffmpeg-bridge.js"), "// bridge\n"),
    writeFile(packagePath, JSON.stringify({ buildVersion: "49738", main: "app_launcher/index.js" })),
    writeFile(join(qqDataRoot, "Documents/loadNapCat.js"), "// loader\n"),
    writeFile(join(napCatRoot, "napcat.mjs"), "// unknown upstream layout\n"),
    writeFile(oneBotPath, JSON.stringify({ network: { httpServers: [], httpClients: [] } })),
    writeFile(napCatConfigPath, JSON.stringify({ packetBackend: "auto" })),
  ]);
  const beforeOneBot = await readFile(oneBotPath, "utf8");
  const beforeNapCatConfig = await readFile(napCatConfigPath, "utf8");
  await assert.rejects(bootstrapNapCatMacos({
    projectRoot, accountId: "123456", groupId: "234567", eventPort: 32180,
    qqAppPath, qqDataRoot, runtimeEnvironmentPath: join(root, "runtime.env"),
    launchAgentPath: join(root, "bridge.plist"),
    applicationSupportPath: join(root, "Application Support"), reloadLaunchAgent: false,
  }), /executor seam was not found/u);
  assert.equal(await readFile(oneBotPath, "utf8"), beforeOneBot);
  assert.equal(await readFile(napCatConfigPath, "utf8"), beforeNapCatConfig);
  await assert.rejects(stat(join(root, "runtime.env")), { code: "ENOENT" });
});

test("macOS bootstrap rejects a secret path whose parent symlink resolves into the project", async (context) => {
  if (process.platform !== "darwin") {
    context.skip("macOS-only bootstrap");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rma-env-symlink-"));
  const projectRoot = join(root, "project");
  const linkedProject = join(root, "linked-project");
  await mkdir(projectRoot);
  await symlink(projectRoot, linkedProject);
  await assert.rejects(bootstrapNapCatMacos({
    projectRoot,
    accountId: "123456",
    groupId: "234567",
    eventPort: 32180,
    runtimeEnvironmentPath: join(linkedProject, "runtime.env"),
    reloadLaunchAgent: false,
  }), /must not be stored inside the project repository/u);
});
