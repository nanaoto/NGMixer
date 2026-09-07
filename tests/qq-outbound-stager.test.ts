import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QqOutboundArtifactStager } from "../src/qq/outbound-artifact-stager.js";

const digest = "2f907a6de331cc77376c52e70ba55765a30be18cd9bc69587585fbb71b80de1d";
const deliveryDigest = "0b220df1969115139ffebb337981298d243a44f84dad5d20d7e7da5fdb34de43";

test("QQ outbound artifact stager creates a content-addressed QQ-readable copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-qq-outbound-"));
  const sourceDirectory = join(root, "artifact-store", digest);
  const sourcePath = join(sourceDirectory, "demo.mp3");
  const stagingRoot = join(root, "QQData", "Documents", "napcat", "rma-outbound");
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(sourcePath, "mix", { mode: 0o600 });
  const stager = new QqOutboundArtifactStager(stagingRoot);

  const lease = await stager.stage("delivery-1", {
    schema: "rma.artifact-ref/v1",
    artifactId: `artifact:${digest}`,
    kind: "audio",
    availability: "available",
    mediaType: "audio/mpeg",
    fileName: "demo.mp3",
    bytes: 3,
    sha256: digest,
  }, {
    filePath: sourcePath,
    fileName: "demo.mp3",
  }, new AbortController().signal);

  assert.deepEqual(lease.artifact, {
    filePath: join(await realpath(stagingRoot), `${digest}-${deliveryDigest}.mp3`),
    fileName: "demo.mp3",
  });
  assert.equal(await readFile(lease.artifact.filePath, "utf8"), "mix");
  const metadata = await stat(lease.artifact.filePath);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.mode & 0o777, 0o644);
  await lease.release();
  await assert.rejects(stat(lease.artifact.filePath), { code: "ENOENT" });
});
