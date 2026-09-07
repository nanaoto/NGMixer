import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { artifactRefSchema, type ArtifactRef } from "../contracts/communication.js";

const materialRecordSchema = z.strictObject({
  schema: z.literal("rma.material-record/v1"),
  accountId: z.string().min(1),
  ownerId: z.string().min(1),
  messageId: z.string().min(1),
  artifact: artifactRefSchema,
});

export interface RememberMaterialRequest {
  readonly accountId: string;
  readonly ownerId: string;
  readonly messageId: string;
  readonly artifact: ArtifactRef;
}

export interface MaterialLibraryEntry {
  readonly accountId: string;
  readonly ownerId: string;
  readonly messageId: string;
  readonly artifact: ArtifactRef;
}

export interface MaterialLibraryScope {
  readonly accountId?: string;
  readonly ownerId?: string;
}

export interface MaterialLibrary {
  list(accountId: string, ownerId: string): Promise<ArtifactRef[]>;
  inventory(scope?: MaterialLibraryScope): Promise<MaterialLibraryEntry[]>;
  find(artifactId: string, scope?: MaterialLibraryScope): Promise<MaterialLibraryEntry | undefined>;
}

export class JsonlMaterialCatalog implements MaterialLibrary {
  #queue: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  async #read() {
    try {
      return (await readFile(this.path, "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => materialRecordSchema.parse(JSON.parse(line)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public async remember(request: RememberMaterialRequest): Promise<void> {
    const operation = this.#queue.then(async () => {
      const record = materialRecordSchema.parse({ schema: "rma.material-record/v1", ...request });
      const records = await this.#read();
      if (records.some((candidate) =>
        candidate.accountId === record.accountId
        && candidate.ownerId === record.ownerId
        && candidate.artifact.artifactId === record.artifact.artifactId)) return;
      await mkdir(dirname(this.path), { recursive: true });
      const handle = await open(this.path, "a");
      try {
        await handle.write(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.#queue = operation.then(() => undefined, () => undefined);
    await operation;
  }

  public async list(accountId: string, ownerId: string): Promise<ArtifactRef[]> {
    return (await this.inventory({ accountId, ownerId })).map((entry) => entry.artifact);
  }

  public async inventory(scope: MaterialLibraryScope = {}): Promise<MaterialLibraryEntry[]> {
    await this.#queue;
    const unique = new Map<string, MaterialLibraryEntry>();
    for (const record of await this.#read()) {
      if (scope.accountId !== undefined && record.accountId !== scope.accountId) continue;
      if (scope.ownerId !== undefined && record.ownerId !== scope.ownerId) continue;
      const key = `${record.accountId}\u0000${record.ownerId}\u0000${record.artifact.artifactId}`;
      unique.set(key, {
        accountId: record.accountId,
        ownerId: record.ownerId,
        messageId: record.messageId,
        artifact: record.artifact,
      });
    }
    return [...unique.values()];
  }

  public async find(
    artifactId: string,
    scope: MaterialLibraryScope = {},
  ): Promise<MaterialLibraryEntry | undefined> {
    const canonicalId = /^[0-9a-f]{64}$/u.test(artifactId) ? `artifact:${artifactId}` : artifactId;
    return (await this.inventory(scope)).find((entry) => entry.artifact.artifactId === canonicalId);
  }
}
