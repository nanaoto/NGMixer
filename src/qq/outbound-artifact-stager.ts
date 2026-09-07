import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { extname, join } from "node:path";

import type { ResolvedArtifact } from "../communication/napcat-module.js";
import type { StagedOutboundArtifact } from "../communication/napcat-module.js";
import type { ArtifactRef } from "../contracts/communication.js";
import { sha256File } from "../fs/content-digest.js";

function safeExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : "";
}

export class QqOutboundArtifactStager {
  public constructor(private readonly root: string) {}

  public async stage(
    deliveryId: string,
    artifact: ArtifactRef,
    resolved: ResolvedArtifact,
    signal: AbortSignal,
  ): Promise<StagedOutboundArtifact> {
    signal.throwIfAborted();
    if (!artifact.sha256 || artifact.artifactId !== `artifact:${artifact.sha256}`) {
      throw new Error("outbound artifact has no trustworthy content digest");
    }
    const source = await stat(resolved.filePath);
    if (!source.isFile()) throw new Error("outbound artifact is not a regular file");
    if (artifact.bytes !== undefined && source.size !== artifact.bytes) {
      throw new Error("outbound artifact size changed before staging");
    }

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stagingRoot = await realpath(this.root);
    const deliveryDigest = createHash("sha256").update(deliveryId).digest("hex");
    const destination = join(
      stagingRoot,
      `${artifact.sha256}-${deliveryDigest}${safeExtension(resolved.fileName)}`,
    );
    const stagedArtifact = { filePath: destination, fileName: resolved.fileName };
    const release = async (): Promise<void> => {
      try {
        await unlink(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("QQ outbound staging target is not a regular file");
      }
      if (existing.size !== source.size || await sha256File(destination, signal) !== artifact.sha256) {
        throw new Error("QQ outbound staging target does not match its content address");
      }
      await chmod(destination, 0o644);
      return { artifact: stagedArtifact, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = join(stagingRoot, `.${artifact.sha256}.${randomUUID()}.tmp`);
    try {
      await copyFile(resolved.filePath, temporary, constants.COPYFILE_EXCL);
      signal.throwIfAborted();
      const copied = await stat(temporary);
      if (!copied.isFile() || copied.size !== source.size) {
        throw new Error("QQ outbound staged copy is incomplete");
      }
      if (await sha256File(temporary, signal) !== artifact.sha256) {
        throw new Error("QQ outbound staged copy failed content verification");
      }
      await chmod(temporary, 0o644);
      await rename(temporary, destination);
      return { artifact: stagedArtifact, release };
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
