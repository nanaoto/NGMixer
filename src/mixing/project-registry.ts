import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const projectEntrySchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  projectPath: z.string().min(1),
  currentVersion: z.number().int().nonnegative(),
  registeredAt: z.string().datetime({ offset: true }),
  note: z.string().optional(),
});

const projectRegistrySchema = z.strictObject({
  schema: z.literal("rma.project-registry/v1"),
  projects: z.array(projectEntrySchema),
});

export type ProjectRegistryEntry = z.infer<typeof projectEntrySchema>;

export interface ProjectRegistry {
  list(): Promise<readonly ProjectRegistryEntry[]>;
  find(name: string): Promise<ProjectRegistryEntry | undefined>;
  advanceVersion(sessionId: string, version: number): Promise<void>;
}

function identity(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase("en-US");
}

export class JsonProjectRegistry implements ProjectRegistry {
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly path: string) {}

  public async list(): Promise<readonly ProjectRegistryEntry[]> {
    try {
      return projectRegistrySchema.parse(JSON.parse(await readFile(this.path, "utf8"))).projects;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public async find(name: string): Promise<ProjectRegistryEntry | undefined> {
    const wanted = identity(name);
    return (await this.list()).find((project) => identity(project.name) === wanted);
  }

  public async advanceVersion(sessionId: string, version: number): Promise<void> {
    if (!Number.isInteger(version) || version < 1) throw new TypeError("project version must be positive");
    const persist = this.writeQueue.then(async () => {
      const registry = projectRegistrySchema.parse(JSON.parse(await readFile(this.path, "utf8")));
      const index = registry.projects.findIndex((project) => project.sessionId === sessionId);
      if (index < 0) return;
      const current = registry.projects[index]!;
      if (current.currentVersion >= version) return;
      registry.projects[index] = { ...current, currentVersion: version };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, resolve(this.path));
    });
    this.writeQueue = persist.catch(() => undefined);
    await persist;
  }
}
