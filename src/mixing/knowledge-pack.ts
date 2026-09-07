import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

import { z } from "zod";

export const mixingKnowledgeSchema = "rma.mixing-knowledge/v2" as const;

const maximumManifestBytes = 32 * 1024;
const maximumDocumentBytes = 16 * 1024;
const maximumCorpusBytes = 256 * 1024;
const defaultKnowledgeUrl = new URL("../../knowledge/catalog.json", import.meta.url);
const knowledgeDocumentKindSchema = z.enum(["operational", "source-map", "source-outline"]);
export type MixingKnowledgeDocumentKind = z.infer<typeof knowledgeDocumentKindSchema>;
const knowledgeReviewStateSchema = z.enum(["outline", "reviewed", "operationalized"]);

const printedPageRangeSchema = z.strictObject({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
}).refine((range) => range.end >= range.start, "printed page range must not be reversed");

const manifestDocumentSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
  path: z.string().regex(/^[0-9]{2}-[a-z0-9-]+\.md$/u),
  title: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(40)).min(1).max(24),
  always: z.boolean().default(false),
  kind: knowledgeDocumentKindSchema.default("operational"),
  coverage: z.strictObject({
    printedPages: printedPageRangeSchema,
    aliases: z.array(z.string().min(1).max(80)).min(1).max(24),
    reviewState: knowledgeReviewStateSchema,
  }).optional(),
}).superRefine((document, context) => {
  if (document.kind === "source-outline" && !document.coverage) {
    context.addIssue({
      code: "custom",
      message: `source-outline document ${document.id} requires coverage`,
      path: ["coverage"],
    });
  }
  if (document.kind !== "source-outline" && document.coverage) {
    context.addIssue({
      code: "custom",
      message: `${document.kind} document ${document.id} must not declare source-outline coverage`,
      path: ["coverage"],
    });
  }
});

const bookSourceSchema = z.strictObject({
  title: z.string().min(1),
  author: z.string().min(1),
  publisher: z.string().min(1),
  edition: z.string().min(1),
  isbn: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  printedPages: printedPageRangeSchema,
});

const courseSourceSchema = z.strictObject({
  kind: z.literal("course-handouts"),
  title: z.string().min(1),
  author: z.string().min(1),
  edition: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  handouts: z.array(z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/u),
    title: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })).min(1).max(32),
});

const projectSourceSchema = z.strictObject({
  kind: z.literal("project-authored"),
  title: z.string().min(1),
  author: z.string().min(1),
  license: z.string().min(1),
});

const manifestSchema = z.strictObject({
  schema: z.literal("rma.mixing-knowledge-manifest/v1"),
  id: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  source: z.union([bookSourceSchema, courseSourceSchema, projectSourceSchema]),
  documents: z.array(manifestDocumentSchema).min(2).max(64),
});

const catalogSchema = z.strictObject({
  schema: z.literal("rma.mixing-knowledge-catalog/v1"),
  id: z.string().min(1).max(100),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  packs: z.array(z.strictObject({
    path: z.string().regex(/^[a-z0-9][a-z0-9/-]*\/manifest\.json$/u),
  })).min(1).max(16),
});

type KnowledgeManifest = z.infer<typeof manifestSchema>;

interface IndexedKnowledgeDocument {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly always: boolean;
  readonly kind: MixingKnowledgeDocumentKind;
  readonly sourceTerms: string;
  readonly sourceAliases: readonly string[];
  readonly sha256: string;
  readonly content: string;
}

export interface MixingKnowledgeSearchRequest {
  readonly query: string;
  readonly limit?: number;
}

export interface MixingKnowledgeHit {
  readonly id: string;
  readonly title: string;
  readonly score: number;
  readonly kind: MixingKnowledgeDocumentKind;
  readonly sha256: string;
  readonly content: string;
}

export interface MixingKnowledgeEvidence {
  readonly schema: typeof mixingKnowledgeSchema;
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly documents: readonly Readonly<{ id: string; sha256: string }>[];
}

export interface MixingKnowledgeSelection extends MixingKnowledgeEvidence {
  readonly query: string;
  readonly hits: readonly MixingKnowledgeHit[];
}

export interface MixingKnowledgeLibrary {
  search(request: MixingKnowledgeSearchRequest): Promise<MixingKnowledgeSelection>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readBoundedRegularFile(url: URL, maximumBytes: number, label: string): Promise<string> {
  const metadata = await lstat(url);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (metadata.size === 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be 1..${maximumBytes} bytes`);
  }
  return readFile(url, "utf8");
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function searchTerms(query: string): readonly string[] {
  const value = normalized(query);
  const terms = new Set<string>();
  for (const match of value.matchAll(/[a-z0-9][a-z0-9+._-]{1,}/gu)) terms.add(match[0]);
  for (const match of value.matchAll(/[\p{Script=Han}]+/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return [...terms];
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (count < 4) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

function assertLeafSectionCoverage(
  documentId: string,
  content: string,
  coverage: Readonly<{ start: number; end: number }>,
): void {
  const bullets = [...content.matchAll(/^(\s*)- .*?印刷页 (\d+)–(\d+)(?:[。；：]|$)/gmu)]
    .map((match) => ({
      indentation: match[1]?.length ?? 0,
      start: Number.parseInt(match[2] ?? "", 10),
      end: Number.parseInt(match[3] ?? "", 10),
    }));
  const leaves = bullets.filter((bullet, index) => {
    const next = bullets[index + 1];
    return !next || next.indentation <= bullet.indentation;
  }).sort((left, right) => left.start - right.start || left.end - right.end);
  let coveredThrough = coverage.start - 1;
  for (const span of leaves) {
    if (span.start < coverage.start || span.end > coverage.end || span.end < span.start) {
      throw new Error(`mixing knowledge leaf-section coverage escapes ${documentId}`);
    }
    if (span.start > coveredThrough + 1) {
      throw new Error(
        `mixing knowledge leaf-section coverage is discontinuous at printed page ${coveredThrough + 1} in ${documentId}`,
      );
    }
    coveredThrough = Math.max(coveredThrough, span.end);
  }
  if (coveredThrough !== coverage.end) {
    throw new Error(
      `mixing knowledge leaf-section coverage is discontinuous at printed page ${coveredThrough + 1} in ${documentId}`,
    );
  }
}

function documentScore(
  document: IndexedKnowledgeDocument,
  terms: readonly string[],
  query: string,
): number {
  const title = normalized(document.title);
  const tags = normalized(document.tags.join(" "));
  const sourceTerms = normalized(document.sourceTerms);
  const content = normalized(document.content);
  const termScore = terms.reduce((total, term) => total
    + (title.includes(term) ? 12 : 0)
    + (tags.includes(term) ? 8 : 0)
    + (sourceTerms.includes(term) ? 20 : 0)
    + occurrences(content, term), 0);
  const exactSourceAlias = document.sourceAliases.some((alias) => normalized(query).includes(normalized(alias)));
  const weightedTermScore = document.kind === "operational" ? termScore : Math.round(termScore * 0.25);
  return weightedTermScore + (exactSourceAlias ? 100 : 0);
}

export class FileMixingKnowledgeLibrary implements MixingKnowledgeLibrary {
  public constructor(private readonly knowledgeUrl: URL = defaultKnowledgeUrl) {}

  public async search(request: MixingKnowledgeSearchRequest): Promise<MixingKnowledgeSelection> {
    const query = request.query.trim();
    if (!query || query.length > 2_000) throw new TypeError("mixing knowledge query must be 1..2000 characters");
    const limit = request.limit ?? 6;
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new TypeError("mixing knowledge limit must be an integer from 1 to 8");
    }

    const rootText = await readBoundedRegularFile(
      this.knowledgeUrl,
      maximumManifestBytes,
      "mixing knowledge root",
    );
    const rootValue: unknown = JSON.parse(rootText);
    const rootSchema = typeof rootValue === "object" && rootValue !== null && "schema" in rootValue
      ? rootValue.schema
      : undefined;
    const packs: readonly Readonly<{ manifest: KnowledgeManifest; text: string; url: URL }>[] = rootSchema
      === "rma.mixing-knowledge-catalog/v1"
      ? await Promise.all(catalogSchema.parse(rootValue).packs.map(async (pack) => {
        const url = new URL(pack.path, this.knowledgeUrl);
        const text = await readBoundedRegularFile(url, maximumManifestBytes, `mixing knowledge pack ${pack.path}`);
        return { manifest: manifestSchema.parse(JSON.parse(text)), text, url };
      }))
      : [{ manifest: manifestSchema.parse(rootValue), text: rootText, url: this.knowledgeUrl }];
    const root = rootSchema === "rma.mixing-knowledge-catalog/v1"
      ? catalogSchema.parse(rootValue)
      : packs[0]!.manifest;
    const entries = packs.flatMap(({ manifest }) => manifest.documents);
    if (new Set(entries.map((document) => document.id)).size !== entries.length) {
      throw new Error("mixing knowledge document ids must be unique");
    }
    for (const { manifest } of packs) {
      if (!("printedPages" in manifest.source)) continue;
      const coverage = manifest.documents
        .flatMap((document) => document.coverage ? [{ id: document.id, ...document.coverage.printedPages }] : [])
        .sort((left, right) => left.start - right.start);
      let expectedPage = manifest.source.printedPages.start;
      for (const span of coverage) {
        if (span.start !== expectedPage) {
          throw new Error(`mixing knowledge source coverage is discontinuous before ${span.id}`);
        }
        expectedPage = span.end + 1;
      }
      if (expectedPage !== manifest.source.printedPages.end + 1) {
        throw new Error("mixing knowledge source coverage does not reach the final printed page");
      }
    }

    let corpusBytes = 0;
    const indexed: IndexedKnowledgeDocument[] = [];
    for (const pack of packs) {
      for (const entry of pack.manifest.documents) {
        const content = await readBoundedRegularFile(
          new URL(entry.path, pack.url),
          maximumDocumentBytes,
          `mixing knowledge document ${entry.id}`,
        );
        corpusBytes += Buffer.byteLength(content);
        if (corpusBytes > maximumCorpusBytes) throw new Error("mixing knowledge corpus exceeds its byte budget");
        if (!content.startsWith(`# ${entry.title}\n`)) {
          throw new Error(`mixing knowledge document ${entry.id} has an unexpected title`);
        }
        if (entry.coverage) {
          const stateMarker = `录入层级：\`${entry.coverage.reviewState}\``;
          if (!content.includes(stateMarker)) {
            throw new Error(`mixing knowledge document ${entry.id} does not match its review state`);
          }
          assertLeafSectionCoverage(entry.id, content, entry.coverage.printedPages);
        }
        indexed.push({
          ...entry,
          sourceTerms: `${pack.manifest.source.title} ${pack.manifest.source.author} ${entry.coverage?.aliases.join(" ") ?? ""}`,
          sourceAliases: entry.coverage?.aliases ?? [],
          content,
          sha256: sha256(content),
        });
      }
    }

    const terms = searchTerms(query);
    const ranked = indexed
      .map((document, order) => ({ document, order, score: documentScore(document, terms, query) }))
      .sort((left, right) => right.score - left.score || left.order - right.order);
    const selected = new Map<string, { document: IndexedKnowledgeDocument; score: number }>();
    for (const document of indexed.filter((candidate) => candidate.always)) {
      if (selected.size >= limit) break;
      selected.set(document.id, { document, score: documentScore(document, terms, query) });
    }
    for (const candidate of ranked) {
      if (selected.size >= limit) break;
      if (candidate.score > 0 || selected.size === 0) selected.set(candidate.document.id, candidate);
    }
    for (const candidate of ranked) {
      if (selected.size >= limit) break;
      selected.set(candidate.document.id, candidate);
    }

    const hits = [...selected.values()].map(({ document, score }) => ({
      id: document.id,
      title: document.title,
      score,
      kind: document.kind,
      sha256: document.sha256,
      content: document.content,
    }));
    const documents = hits.map(({ id, sha256: digest }) => ({ id, sha256: digest }));
    const selectionHash = sha256(JSON.stringify({
      root: sha256(rootText),
      packs: packs.map((pack) => ({ id: pack.manifest.id, manifest: sha256(pack.text) })),
      query,
      documents,
    }));
    return {
      schema: mixingKnowledgeSchema,
      id: root.id,
      version: root.version,
      sha256: selectionHash,
      documents,
      query,
      hits,
    };
  }
}

export function mixingKnowledgeEvidence(selection: MixingKnowledgeSelection): MixingKnowledgeEvidence {
  return {
    schema: selection.schema,
    id: selection.id,
    version: selection.version,
    sha256: selection.sha256,
    documents: selection.documents,
  };
}

export function appendMixingKnowledge(
  plannerInstructions: string,
  selection: MixingKnowledgeSelection,
): string {
  const content = selection.hits.map((hit) => hit.content).join("\n\n");
  return `${plannerInstructions}\n\nThe following documents were retrieved from the versioned local mixing knowledge library for this request. Documents marked operational contain [D] invariants, [O] procedures you perform from tools and evidence, and [H] hypotheses. Documents marked source-map or source-outline are navigation and coverage records: use them to locate a topic, never as an exact source claim or parameter prescription until reviewed. Do not ask the user to perform technical observations, calculations, meter reading, or A/B for you. Retrieved knowledge is not a preset and never overrides current analysis or explicit user constraints.\n<mixing-knowledge-selection id="${selection.id}" version="${selection.version}" sha256="${selection.sha256}" documents="${selection.documents.map((document) => document.id).join(",")}">\n${content}\n</mixing-knowledge-selection>`;
}
