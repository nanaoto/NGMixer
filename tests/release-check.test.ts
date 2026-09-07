import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runReleaseCheck } from "../src/release-check.js";

const executeFile = promisify(execFile);

const requiredFiles = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ".github/workflows/ci.yml",
  "config/local.example.toml",
  "knowledge/catalog.json",
  "knowledge/public-core/README.md",
];
// Deliberately independent from the implementation: this is the public release contract.

test("release check rejects secrets and machine-specific paths without echoing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "rma-release-check-"));
  for (const file of requiredFiles) {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${file}\n`);
  }
  await mkdir(join(root, "src"), { recursive: true });
  const sourcePath = join(root, "src", "index.ts");
  await writeFile(sourcePath, "export const ready = true;\n");
  await executeFile("git", ["init", "--quiet"], { cwd: root });
  await executeFile("git", ["add", "."], { cwd: root });

  assert.deepEqual(await runReleaseCheck(root), {
    ok: true,
    lines: ["PASS open-source release checks"],
  });

  for (const name of ["reaper.jpg", "reaper.png", "deepseek-harness.png"]) {
    const logoPath = join(root, "assets", "logos", name);
    await mkdir(dirname(logoPath), { recursive: true });
    await writeFile(logoPath, await readFile(new URL(`../assets/logos/${name}`, import.meta.url)));
    await executeFile("git", ["add", `assets/logos/${name}`], { cwd: root });
  }
  assert.equal((await runReleaseCheck(root)).ok, true);

  const leakedKey = `sk-${"a".repeat(48)}`;
  await writeFile(sourcePath, `export const key = ${JSON.stringify(leakedKey)};\n`);
  const secretReport = await runReleaseCheck(root);
  assert.equal(secretReport.ok, false);
  assert.match(secretReport.lines.join("\n"), /possible credential/u);
  assert.doesNotMatch(secretReport.lines.join("\n"), new RegExp(leakedKey, "u"));

  const machinePath = ["", "Users", "alice", "private-audio"].join("/");
  await writeFile(sourcePath, `export const root = ${JSON.stringify(machinePath)};\n`);
  const pathReport = await runReleaseCheck(root);
  assert.equal(pathReport.ok, false);
  assert.match(pathReport.lines.join("\n"), /machine-specific absolute path/u);

  const volumePath = ["", "Volumes", "studio", "private-audio"].join("/");
  await writeFile(sourcePath, `export const root = ${JSON.stringify(volumePath)};\n`);
  assert.equal((await runReleaseCheck(root)).ok, false);

  await writeFile(sourcePath, "export const ready = true;\n");
  const projectPath = join(root, "private", "session.rpp");
  await mkdir(dirname(projectPath), { recursive: true });
  await writeFile(projectPath, "<REAPER_PROJECT>\n");
  await executeFile("git", ["add", "private/session.rpp"], { cwd: root });
  const artifactReport = await runReleaseCheck(root);
  assert.equal(artifactReport.ok, false);
  assert.match(artifactReport.lines.join("\n"), /generated, private, or media path/u);

  const binaryPath = join(root, "assets", "opaque.bin");
  await mkdir(dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
  await executeFile("git", ["add", "assets/opaque.bin"], { cwd: root });
  const binaryReport = await runReleaseCheck(root);
  assert.equal(binaryReport.ok, false);
  assert.match(binaryReport.lines.join("\n"), /binary tracked file requires explicit review/u);
});
