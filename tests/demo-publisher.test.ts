import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { LocalArtifactStore } from "../src/communication/artifact-store.js";
import {
  demoPublishErrorCode,
  DemoPublishError,
  FfmpegDemoPublisher,
} from "../src/mixing/demo-publisher.js";
import type { RenderedDemoArtifact } from "../src/mixing/execution.js";

function rendered(path: string): RenderedDemoArtifact {
  return {
    projectId: "project-1",
    path,
    fileName: basename(path),
    sampleRate: 48_000,
    channels: 2,
    format: "wav",
    bytes: 12,
    sha256: "0".repeat(64),
    renderBounds: "entire-project",
    tailSeconds: 2,
  };
}

test("FFmpeg demo publisher makes a 320 kbps MP3 artifact for QQ delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-demo-publisher-"));
  const renderDirectory = join(root, "session", "renders", "run-1");
  await mkdir(renderDirectory, { recursive: true });
  const source = join(renderDirectory, "demo.wav");
  await writeFile(source, "rendered wav");
  const calls: Array<{ executable: string; args: readonly string[] }> = [];
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const publisher = new FfmpegDemoPublisher({
    audioWorkRoot: root,
    ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
    artifactStore: store,
    run: async (executable, args) => {
      calls.push({ executable, args });
      const output = args.at(-1);
      assert.ok(output);
      await writeFile(output, "encoded mp3");
    },
  });

  const artifact = await publisher.publish(rendered(source), "mp3", new AbortController().signal);

  assert.equal(artifact.fileName, "demo.mp3");
  assert.equal(artifact.mediaType, "audio/mpeg");
  assert.equal(artifact.kind, "audio");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.executable, "/opt/homebrew/bin/ffmpeg");
  assert.deepEqual(calls[0]?.args.slice(0, -1), [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    source,
    "-map",
    "0:a:0",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "320k",
  ]);
  assert.match(calls[0]?.args.at(-1) ?? "", /\.incoming-[a-f0-9-]+\.mp3$/u);
  assert.equal((await store.resolve(artifact, new AbortController().signal)).fileName, "demo.mp3");
});

test("FFmpeg demo publisher preserves WAV when explicitly requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-demo-publisher-wav-"));
  const source = join(root, "demo.wav");
  await writeFile(source, "rendered wav");
  let calls = 0;
  const publisher = new FfmpegDemoPublisher({
    audioWorkRoot: root,
    ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    run: async () => { calls += 1; },
  });

  const artifact = await publisher.publish(rendered(source), "wav", new AbortController().signal);

  assert.equal(artifact.fileName, "demo.wav");
  assert.equal(artifact.mediaType, "audio/wav");
  assert.equal(calls, 0);
});

test("FFmpeg demo publisher rejects a render outside audio_work_root", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-demo-publisher-root-"));
  const outside = await mkdtemp(join(tmpdir(), "rma-demo-publisher-outside-"));
  const source = join(outside, "demo.wav");
  await writeFile(source, "rendered wav");
  let calls = 0;
  const publisher = new FfmpegDemoPublisher({
    audioWorkRoot: root,
    ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    run: async () => { calls += 1; },
  });

  await assert.rejects(
    publisher.publish(rendered(source), "mp3", new AbortController().signal),
    /outside audio_work_root/u,
  );
  assert.equal(calls, 0);
});

test("FFmpeg demo publisher rejects an empty encode with a stable path-free error", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-demo-publisher-empty-"));
  const source = join(root, "private-session-name.wav");
  await writeFile(source, "rendered wav");
  const publisher = new FfmpegDemoPublisher({
    audioWorkRoot: root,
    ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
    artifactStore: new LocalArtifactStore(join(root, "artifacts")),
    run: async (_executable, args) => {
      const output = args.at(-1);
      assert.ok(output);
      await writeFile(output, "");
    },
  });

  await assert.rejects(
    publisher.publish(rendered(source), "mp3", new AbortController().signal),
    (error: unknown) => error instanceof DemoPublishError
      && error.code === demoPublishErrorCode
      && error.message === "RMA_RENDER_FAILED: delivery audio publication failed"
      && !error.message.includes(root),
  );
});
