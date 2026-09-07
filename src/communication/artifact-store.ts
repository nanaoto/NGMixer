import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync, writeSync } from "node:fs";
import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { Unzip, UnzipInflate } from "fflate";

import type { ArtifactRef } from "../contracts/communication.js";
import { sha256File } from "../fs/content-digest.js";
import type { ResolvedArtifact } from "./napcat-module.js";

export interface ImportFileRequest {
  readonly kind: ArtifactRef["kind"];
  readonly filePath: string;
  readonly fileName: string;
  readonly mediaType?: string;
}

function decodeZipEntryName(value: string): string {
  if ([...value].some((character) => character.charCodeAt(0) > 0xff)) return value;
  const bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
  }
}

function safeZipEntryPath(value: string): string {
  const normalized = decodeZipEntryName(value).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.includes("\0")
    || normalized.startsWith("/")
    || /^[a-z]:\//iu.test(normalized)
    || segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`ZIP has unsafe entry path: ${JSON.stringify(normalized)}`);
  }
  return normalized;
}

function importedKind(fileName: string): Pick<ImportFileRequest, "kind" | "mediaType"> {
  const mediaTypes: Readonly<Record<string, string>> = {
    ".aac": "audio/aac",
    ".aif": "audio/aiff",
    ".aiff": "audio/aiff",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
  };
  const mediaType = mediaTypes[extname(fileName).toLowerCase()];
  return mediaType ? { kind: "audio", mediaType } : { kind: "file" };
}

export class LocalArtifactStore {
  public constructor(
    private readonly root: string,
    private readonly maxBytes = 512 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes must be positive");
  }

  public async importFile(request: ImportFileRequest, signal: AbortSignal): Promise<ArtifactRef> {
    signal.throwIfAborted();
    const fileName = basename(request.fileName);
    if (!fileName || fileName === "." || fileName === "..") throw new Error("artifact file name is invalid");
    const sourceMetadata = await stat(request.filePath);
    if (!sourceMetadata.isFile()) throw new Error("received artifact is not a regular file");
    if (sourceMetadata.size > this.maxBytes) {
      throw new Error(`received artifact exceeds ${this.maxBytes} bytes`);
    }
    await mkdir(this.root, { recursive: true });
    const temporaryPath = join(this.root, `.incoming-${randomUUID()}`);
    try {
      await copyFile(request.filePath, temporaryPath);
      signal.throwIfAborted();
      const metadata = await stat(temporaryPath);
      if (!metadata.isFile()) throw new Error("received artifact is not a regular file");
      if (metadata.size > this.maxBytes) {
        throw new Error(`received artifact exceeds ${this.maxBytes} bytes`);
      }
      const digest = await sha256File(temporaryPath, signal);
      const directory = join(this.root, digest);
      const destination = join(directory, fileName);
      await mkdir(directory, { recursive: true });
      await rename(temporaryPath, destination);
      return {
        schema: "rma.artifact-ref/v1",
        artifactId: `artifact:${digest}`,
        kind: request.kind,
        availability: "available",
        fileName,
        bytes: metadata.size,
        sha256: digest,
        ...(request.mediaType ? { mediaType: request.mediaType } : {}),
      };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  public async resolve(artifact: ArtifactRef, signal: AbortSignal): Promise<ResolvedArtifact> {
    signal.throwIfAborted();
    if (artifact.availability !== "available" || !artifact.sha256 || !artifact.fileName) {
      throw new Error(`artifact ${artifact.artifactId} is not locally available`);
    }
    if (artifact.artifactId !== `artifact:${artifact.sha256}`) {
      throw new Error(`artifact ${artifact.artifactId} does not match its digest`);
    }
    const fileName = basename(artifact.fileName);
    const filePath = join(this.root, artifact.sha256, fileName);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error(`artifact ${artifact.artifactId} is not a regular file`);
    return { filePath, fileName };
  }

  public async expandZipArchive(archive: ArtifactRef, signal: AbortSignal): Promise<ArtifactRef[]> {
    signal.throwIfAborted();
    if (archive.kind !== "file" || extname(archive.fileName ?? "").toLowerCase() !== ".zip") {
      throw new Error(`artifact ${archive.artifactId} is not a ZIP archive`);
    }
    const resolved = await this.resolve(archive, signal);
    await mkdir(this.root, { recursive: true });
    const temporaryPaths = new Set<string>();
    const staged: Array<{ readonly path: string; readonly fileName: string }> = [];
    let failure: Error | undefined;
    let archiveEntries = 0;
    let expandedBytes = 0;
    const maxExpandedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.maxBytes * 8);

    const parser = new Unzip((file) => {
      let path: string;
      try {
        path = safeZipEntryPath(file.name);
        if (path.endsWith("/")) return;
        archiveEntries += 1;
        if (archiveEntries > 2048) throw new Error("ZIP contains more than 2048 files");
        if (path.split("/").includes("__MACOSX")) return;
        if (file.originalSize !== undefined && file.originalSize > this.maxBytes) {
          throw new Error(`ZIP entry exceeds ${this.maxBytes} bytes`);
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        file.terminate();
        return;
      }

      const temporaryPath = join(this.root, `.incoming-${randomUUID()}`);
      temporaryPaths.add(temporaryPath);
      const descriptor = openSync(temporaryPath, "wx", 0o600);
      let entryBytes = 0;
      let closed = false;
      const close = () => {
        if (!closed) {
          closeSync(descriptor);
          closed = true;
        }
      };
      file.ondata = (error, data, final) => {
        if (failure) {
          close();
          return;
        }
        if (error) {
          failure = error;
          close();
          return;
        }
        if (data) {
          entryBytes += data.length;
          expandedBytes += data.length;
          if (entryBytes > this.maxBytes || expandedBytes > maxExpandedBytes) {
            failure = new Error(`ZIP expansion exceeds its ${maxExpandedBytes} byte workspace budget`);
            close();
            file.terminate();
            return;
          }
          writeSync(descriptor, data);
        }
        if (final) {
          close();
          staged.push({ path: temporaryPath, fileName: basename(path) });
        }
      };
      try {
        file.start();
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        close();
        file.terminate();
      }
    });
    parser.register(UnzipInflate);

    try {
      for await (const chunk of createReadStream(resolved.filePath, { signal, highWaterMark: 64 * 1024 })) {
        if (failure) throw failure;
        parser.push(chunk as Buffer, false);
      }
      parser.push(new Uint8Array(), true);
      if (failure) throw failure;
      if (staged.length === 0) throw new Error("ZIP contains no regular files to expand");
      const artifacts: ArtifactRef[] = [];
      for (const entry of staged) {
        signal.throwIfAborted();
        const kind = importedKind(entry.fileName);
        artifacts.push(await this.importFile({
          ...kind,
          filePath: entry.path,
          fileName: entry.fileName,
        }, signal));
      }
      return artifacts;
    } finally {
      await Promise.all([...temporaryPaths].map(async (path) => unlink(path).catch(() => undefined)));
    }
  }
}
