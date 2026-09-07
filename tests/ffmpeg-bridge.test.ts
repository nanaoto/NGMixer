import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeFfmpegBridgeRequest } from "../src/qq/ffmpeg-bridge.js";

test("FFmpeg bridge is loopback-only, authenticated, and confines file paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-ffmpeg-root-"));
  const options = {
    host: "127.0.0.1",
    port: 0,
    token: "x".repeat(48),
    allowedRoot: root,
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    ffprobePath: "/opt/homebrew/bin/ffprobe",
  } as const;
  assert.equal((await executeFfmpegBridgeRequest(undefined, {}, options)).status, 401);
  const authorization = `Bearer ${"x".repeat(48)}`;
  assert.equal((await executeFfmpegBridgeRequest(
    authorization,
    { tool: "ffmpeg", args: ["-i", "/etc/passwd"] },
    options,
  )).status, 400);
  const response = await executeFfmpegBridgeRequest(
    authorization,
    { tool: "ffmpeg", args: ["-version"] },
    options,
    async () => ({ stdout: "ok", stderr: "" }),
  );
  assert.deepEqual(response, { status: 200, body: { ok: true, stdout: "ok", stderr: "" } });

  const outside = await mkdtemp(join(tmpdir(), "rma-ffmpeg-outside-"));
  const outsideFile = join(outside, "secret.txt");
  await writeFile(outsideFile, "not-readable-through-bridge");
  const escapedLink = join(root, "escaped-link");
  await symlink(outsideFile, escapedLink);
  assert.equal((await executeFfmpegBridgeRequest(
    authorization,
    { tool: "ffmpeg", args: ["-i", escapedLink] },
    options,
  )).status, 400);
});
