import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  appendMixingKnowledge,
  FileMixingKnowledgeLibrary,
  mixingKnowledgeEvidence,
} from "../src/mixing/knowledge-pack.js";

test("the production mixing library retrieves bounded, versioned documents", async () => {
  const library = new FileMixingKnowledgeLibrary();
  const vocal = await library.search({ query: "vocal forwardness masking compression release", limit: 5 });

  assert.equal(vocal.schema, "rma.mixing-knowledge/v2");
  assert.equal(vocal.id, "ngmixer-public-knowledge");
  assert.equal(vocal.version, "1.0.0");
  assert.match(vocal.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(vocal.query, "vocal forwardness masking compression release");
  assert.ok(vocal.hits.length <= 5);
  assert.ok(vocal.hits.length >= 3);
  assert.deepEqual(vocal.hits.slice(0, 2).map((hit) => hit.id), [
    "core-evidence",
    "project-editing-routing",
  ]);
  assert.ok(vocal.hits.some((hit) => hit.id === "frequency-eq"));
  assert.ok(vocal.hits.some((hit) => hit.id === "dynamics"));
  assert.ok(vocal.hits.every((hit) => Buffer.byteLength(hit.content) < 16 * 1024));
  assert.match(vocal.hits.find((hit) => hit.id === "frequency-eq")?.content ?? "", /masking reduction/u);

  const lowEnd = await library.search({ query: "low-frequency masking level reference", limit: 6 });
  assert.ok(lowEnd.hits.some((hit) => hit.id === "frequency-eq"));
  assert.ok(lowEnd.hits.some((hit) => hit.id === "metering-reference"));
  assert.notDeepEqual(lowEnd.documents, vocal.documents);

  const space = await library.search({
    query: "wider chorus reverb delay mono translation",
    limit: 6,
  });
  assert.ok(space.hits.some((hit) => hit.id === "space-stereo"));
  assert.match(
    space.hits.find((hit) => hit.id === "space-stereo")?.content ?? "",
    /mono compatibility/u,
  );

  const evidence = mixingKnowledgeEvidence(vocal);
  assert.equal("hits" in evidence, false);
  assert.equal("query" in evidence, false);
  assert.deepEqual(evidence.documents, vocal.documents);
});

test("the public knowledge pack exposes project-authored provenance", async () => {
  const library = new FileMixingKnowledgeLibrary();
  const selection = await library.search({ query: "evidence routing metering EQ dynamics space", limit: 8 });
  assert.equal(selection.id, "ngmixer-public-knowledge");
  assert.equal(selection.hits.length, 6);
  assert.ok(selection.hits.every((hit) => hit.kind === "operational"));
});

test("planner framing contains only the retrieved document selection", () => {
  const system = appendMixingKnowledge("base instructions", {
    schema: "rma.mixing-knowledge/v2",
    id: "test-library",
    version: "2.0.0",
    sha256: "abc123",
    documents: [{ id: "vocals", sha256: "def456" }],
    query: "vocal",
    hits: [{
      id: "vocals",
      title: "Vocals",
      score: 42,
      kind: "operational",
      sha256: "def456",
      content: "diagnose the vocal before processing",
    }],
  });

  assert.match(system, /not a preset/u);
  assert.match(system, /Do not ask the user to perform technical observations/u);
  assert.match(system, /<mixing-knowledge-selection id="test-library" version="2\.0\.0"/u);
  assert.match(system, /documents="vocals"/u);
  assert.match(system, /diagnose the vocal before processing/u);
});

test("the library rejects gaps in document and leaf-section printed-page coverage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rma-knowledge-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "manifest.json");
  const document = (id: string, path: string, title: string, start: number, end: number) => ({
    id,
    path,
    title,
    tags: [id],
    always: false,
    kind: "source-outline",
    coverage: { printedPages: { start, end }, aliases: [id], reviewState: "outline" },
  });
  await writeFile(
    join(directory, "00-first.md"),
    "# First\n\n录入层级：`outline`。\n\n- first，印刷页 2–2。\n- missing middle，印刷页 4–4。\n",
  );
  await writeFile(
    join(directory, "01-second.md"),
    "# Second\n\n录入层级：`outline`。\n\n- second，印刷页 4–4。\n",
  );
  const manifest = {
    schema: "rma.mixing-knowledge-manifest/v1",
    id: "coverage-fixture",
    version: "1.0.0",
    source: {
      title: "Fixture",
      author: "Fixture",
      publisher: "Fixture",
      edition: "Fixture",
      isbn: "Fixture",
      sha256: "0".repeat(64),
      printedPages: { start: 2, end: 4 },
    },
    documents: [
      document("first", "00-first.md", "First", 2, 2),
      document("second", "01-second.md", "Second", 4, 4),
    ],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));

  const library = new FileMixingKnowledgeLibrary(pathToFileURL(manifestPath));
  await assert.rejects(
    library.search({ query: "fixture" }),
    /source coverage is discontinuous before second/u,
  );

  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    documents: [
      document("first", "00-first.md", "First", 2, 4),
      {
        id: "second",
        path: "01-second.md",
        title: "Second",
        tags: ["second"],
        always: false,
        kind: "operational",
      },
    ],
  }));
  await assert.rejects(
    library.search({ query: "fixture" }),
    /leaf-section coverage is discontinuous at printed page 3 in first/u,
  );

  await writeFile(
    join(directory, "00-first.md"),
    "# First\n\n录入层级：`outline`。\n\n- all pages，印刷页 2–4。\n",
  );
  await writeFile(manifestPath, JSON.stringify({
    ...manifest,
    documents: [
      document("first", "00-first.md", "First", 2, 4),
      {
        id: "second",
        path: "01-second.md",
        title: "Second",
        tags: ["second"],
        always: false,
        kind: "source-outline",
      },
    ],
  }));
  await assert.rejects(
    library.search({ query: "fixture" }),
    /source-outline document second requires coverage/u,
  );
});
