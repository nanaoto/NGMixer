import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { zipSync } from "fflate";

import { LocalArtifactStore } from "../src/communication/artifact-store.js";

function fakeWav(label: string): Uint8Array {
  const body = Buffer.from(label);
  const wav = Buffer.alloc(12 + body.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(4 + body.length, 4);
  wav.write("WAVE", 8, "ascii");
  body.copy(wav, 12);
  return wav;
}

test("LocalArtifactStore imports a NapCat file under content-addressed durable storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-artifacts-"));
  const source = join(root, "private-upload.wav");
  await writeFile(source, Buffer.from("synthetic-wave-data"));
  const store = new LocalArtifactStore(join(root, "store"), 1024);

  const artifact = await store.importFile({
    kind: "audio",
    filePath: source,
    fileName: "../../take.wav",
  }, new AbortController().signal);
  const resolved = await store.resolve(artifact, new AbortController().signal);

  assert.equal(artifact.availability, "available");
  assert.equal(artifact.fileName, "take.wav");
  assert.match(artifact.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(artifact.artifactId, `artifact:${artifact.sha256}`);
  assert.equal(resolved.fileName, "take.wav");
  assert.equal((await readFile(resolved.filePath, "utf8")), "synthetic-wave-data");
});

test("LocalArtifactStore rejects oversized received files before copying them", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-artifacts-limit-"));
  const source = join(root, "huge.wav");
  await writeFile(source, Buffer.alloc(9));
  const store = new LocalArtifactStore(join(root, "store"), 8);

  await assert.rejects(
    store.importFile({ kind: "audio", filePath: source, fileName: "huge.wav" }, new AbortController().signal),
    /exceeds 8 bytes/u,
  );
});

test("LocalArtifactStore safely expands common audio and project files into content-addressed artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-artifacts-zip-"));
  const source = join(root, "session.zip");
  await writeFile(source, zipSync({
    "session/伴奏.wav": fakeWav("beat"),
    "session/10-主唱.wav": fakeWav("lead"),
    "session/notes.txt": Buffer.from("mix notes"),
    "__MACOSX/session/._伴奏.wav": Buffer.from("metadata"),
  }));
  const store = new LocalArtifactStore(join(root, "store"), 1024 * 1024);
  const archive = await store.importFile({ kind: "file", filePath: source, fileName: "session.zip" }, new AbortController().signal);

  const expanded = await store.expandZipArchive(archive, new AbortController().signal);

  assert.deepEqual(expanded.map((entry) => entry.fileName).sort(), ["10-主唱.wav", "notes.txt", "伴奏.wav"]);
  assert.deepEqual(expanded.map((entry) => entry.kind).sort(), ["audio", "audio", "file"]);
  assert.ok(expanded.every((entry) => entry.availability === "available"));
  const lead = expanded.find((entry) => entry.fileName === "10-主唱.wav");
  assert.ok(lead);
  const resolved = await store.resolve(lead, new AbortController().signal);
  assert.equal((await readFile(resolved.filePath)).subarray(0, 12).toString("ascii"), "RIFF\b\0\0\0WAVE");
});

test("LocalArtifactStore rejects ZIP path traversal instead of flattening it", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-artifacts-zip-traversal-"));
  const source = join(root, "malicious.zip");
  await writeFile(source, zipSync({ "../escape.wav": fakeWav("escape") }));
  const store = new LocalArtifactStore(join(root, "store"), 1024 * 1024);
  const archive = await store.importFile({ kind: "file", filePath: source, fileName: "malicious.zip" }, new AbortController().signal);

  await assert.rejects(
    store.expandZipArchive(archive, new AbortController().signal),
    /unsafe entry path/u,
  );
});

test("LocalArtifactStore bounds the number of expanded archive entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-artifacts-zip-count-"));
  const source = join(root, "many.zip");
  const entries = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [
    `session/${String(index).padStart(4, "0")}.wav`,
    fakeWav(String(index)),
  ]));
  await writeFile(source, zipSync(entries));
  const store = new LocalArtifactStore(join(root, "store"), 1024 * 1024);
  const archive = await store.importFile({ kind: "file", filePath: source, fileName: "many.zip" }, new AbortController().signal);

  await assert.rejects(
    store.expandZipArchive(archive, new AbortController().signal),
    /more than 2048 files/u,
  );
});
