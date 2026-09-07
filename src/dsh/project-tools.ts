import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";

import type { JsonValue } from "../bridge/protocol.js";
import {
  type MaterialLibrary,
  type MaterialLibraryScope,
} from "../communication/material-catalog.js";
import type { ProjectManager } from "../project/project-manager.js";

type ScopeForAgent = (agentId: string) => MaterialLibraryScope | undefined;

const rebuildArgsSchema = z.strictObject({
  projectName: z.string().trim().min(1).max(128),
  materials: z.array(z.strictObject({
    artifactId: z.string().min(1),
    trackName: z.string().trim().min(1).max(128),
  })).min(1).max(64),
  discardCurrent: z.boolean().default(false),
});

function agentScope(exec: { readonly agent?: { readonly id?: unknown } }, resolver?: ScopeForAgent) {
  if (!resolver) return undefined;
  const scope = resolver(String(exec.agent?.id ?? ""));
  if (!scope) throw new Error("project tool has no active material-library scope");
  return scope;
}

export function createMaterialLibraryTool(
  library: MaterialLibrary,
  scopeForAgent?: ScopeForAgent,
) {
  return defineTool({
    name: "list_materials",
    description: "List durable materials received previously. QQ-scoped calls only return files owned by the current sender; these materials survive REAPER project replacement.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          materials: {
            type: "array",
            required: true,
            items: { type: "object", additionalProperties: true },
          },
        },
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const scope = agentScope(exec, scopeForAgent);
      const entries = await library.inventory(scope);
      return {
        materials: entries.map((entry) => ({
          accountId: entry.accountId,
          ownerId: entry.ownerId,
          messageId: entry.messageId,
          artifactId: entry.artifact.artifactId,
          kind: entry.artifact.kind,
          availability: entry.artifact.availability,
          ...(entry.artifact.fileName === undefined ? {} : { fileName: entry.artifact.fileName }),
          ...(entry.artifact.bytes === undefined ? {} : { bytes: entry.artifact.bytes }),
        })),
      };
    },
  });
}

export function createProjectRebuildTool(
  manager: ProjectManager,
  scopeForAgent?: ScopeForAgent,
) {
  return defineTool({
    name: "rebuild_project",
    description: "Create and validate a clean REAPER project from durable materials. Each material becomes an independent source track. Optionally discard the previously active project only after the new project is saved and validated.",
    parameters: {
      projectName: { type: "string", required: true },
      materials: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            artifactId: { type: "string", required: true },
            trackName: { type: "string", required: true },
          },
        },
      },
      discardCurrent: { type: "boolean" },
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute(rawArgs, exec) {
      const args = rebuildArgsSchema.parse(rawArgs);
      const materialScope = agentScope(exec, scopeForAgent);
      const receipt = await manager.rebuild({
        ...args,
        ...(materialScope ? { materialScope } : {}),
        signal: exec.signal,
      });
      return JSON.parse(JSON.stringify(receipt)) as Record<string, JsonValue>;
    },
  });
}
