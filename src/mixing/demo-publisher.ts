import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { LocalArtifactStore } from "../communication/artifact-store.js";
import type { ArtifactRef } from "../contracts/communication.js";
import type { RenderedDemoArtifact } from "./execution.js";

export type DemoDeliveryFormat = "mp3" | "wav";
export const demoPublishErrorCode = "RMA_RENDER_FAILED" as const;

export class DemoPublishError extends Error {
  public readonly code = demoPublishErrorCode;

  public constructor() {
    super(`${demoPublishErrorCode}: delivery audio publication failed`);
    this.name = "DemoPublishError";
  }
}

export interface DemoArtifactPublisher {
  publish(
    rendered: RenderedDemoArtifact,
    format: DemoDeliveryFormat,
    signal: AbortSignal,
  ): Promise<ArtifactRef>;
}

export type FfmpegRunner = (
  executable: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly timeoutMs: number },
) => Promise<void>;

const defaultRunner: FfmpegRunner = async (executable, args, options) => {
  await new Promise<void>((resolveRun, reject) => {
    execFile(executable, [...args], {
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    }, (error) => error ? reject(error) : resolveRun());
  });
};

export interface FfmpegDemoPublisherOptions {
  readonly audioWorkRoot: string;
  readonly ffmpegExecutable: string;
  readonly artifactStore: LocalArtifactStore;
  readonly timeoutMs?: number;
  readonly run?: FfmpegRunner;
}

async function assertAudioWorkPath(path: string, root: string): Promise<void> {
  const [realRoot, realPath] = await Promise.all([realpath(resolve(root)), realpath(resolve(path))]);
  const relation = relative(realRoot, realPath);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("render path is outside audio_work_root");
  }
}

function replaceExtension(fileName: string, extension: string): string {
  const current = extname(fileName);
  return `${current ? fileName.slice(0, -current.length) : fileName}${extension}`;
}

export class FfmpegDemoPublisher implements DemoArtifactPublisher {
  readonly #run: FfmpegRunner;
  readonly #timeoutMs: number;

  public constructor(private readonly options: FfmpegDemoPublisherOptions) {
    if (!isAbsolute(options.audioWorkRoot) || !isAbsolute(options.ffmpegExecutable)) {
      throw new TypeError("FFmpeg publisher paths must be absolute");
    }
    this.#timeoutMs = options.timeoutMs ?? 180_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError("FFmpeg publisher timeout must be a positive integer");
    }
    this.#run = options.run ?? defaultRunner;
  }

  public async publish(
    rendered: RenderedDemoArtifact,
    format: DemoDeliveryFormat,
    signal: AbortSignal,
  ): Promise<ArtifactRef> {
    signal.throwIfAborted();
    await assertAudioWorkPath(rendered.path, this.options.audioWorkRoot);
    if (format === "wav") {
      try {
        return await this.options.artifactStore.importFile({
          kind: "audio",
          filePath: rendered.path,
          fileName: rendered.fileName,
          mediaType: "audio/wav",
        }, signal);
      } catch {
        throw new DemoPublishError();
      }
    }

    const fileName = replaceExtension(basename(rendered.fileName), ".mp3");
    const temporaryPath = join(dirname(rendered.path), `.incoming-${randomUUID()}.mp3`);
    const outputPath = join(dirname(rendered.path), fileName);
    try {
      try {
        await this.#run(this.options.ffmpegExecutable, [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          rendered.path,
          "-map",
          "0:a:0",
          "-codec:a",
          "libmp3lame",
          "-b:a",
          "320k",
          temporaryPath,
        ], { signal, timeoutMs: this.#timeoutMs });
        signal.throwIfAborted();
        const output = await stat(temporaryPath);
        if (!output.isFile() || output.size === 0) throw new Error("FFmpeg output is empty");
        await rename(temporaryPath, outputPath);
        return await this.options.artifactStore.importFile({
          kind: "audio",
          filePath: outputPath,
          fileName,
          mediaType: "audio/mpeg",
        }, signal);
      } catch {
        throw new DemoPublishError();
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
