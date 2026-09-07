import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface ReleaseCheckReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

const requiredFiles = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  ".github/workflows/ci.yml",
  "config/local.example.toml",
  "knowledge/catalog.json",
  "knowledge/public-core/README.md",
] as const;

// Reviewed README logos; sources are recorded in THIRD_PARTY_NOTICES.md.
const approvedBinaryAssets = new Set([
  "assets/logos/reaper.jpg",
  "assets/logos/reaper.png",
  "assets/logos/deepseek-harness.png",
]);

const forbiddenTrackedPath = /^(?:config\/local\.toml|var\/|dist\/|coverage\/|node_modules\/|\.dsh-computer-use\/|\.env(?:\.|$))|\.(?:wav|wave|aif|aiff|flac|mp3|m4a|ogg|mp4|mov|mkv|rpp(?:-bak)?|pdf|zip|7z|rar|tar|tgz|sqlite3?|db|jsonl\.zstd)$/iu;
const possibleCredential = /(?:sk-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
const macUserPath = /\/Users\/([^/\s"']+)\//gu;
const linuxUserPath = /\/home\/([^/\s"']+)\//gu;
const macVolumePath = /\/Volumes\/([^/\s"']+)\//gu;
const placeholderUserNames = new Set(["...", "<user>", "example", "test", "username", "$USER"]);

async function trackedFiles(projectRoot: string): Promise<string[]> {
  const { stdout } = await executeFile("git", ["ls-files", "-z", "--", "."], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  return stdout.split("\0").filter(Boolean).map((file) => {
    const absolute = resolve(projectRoot, file);
    const scoped = relative(projectRoot, absolute);
    return scoped.split(sep).join("/");
  });
}

function containsMachinePath(source: string): boolean {
  for (const pattern of [macUserPath, linuxUserPath]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const userName = match[1];
      if (userName && !placeholderUserNames.has(userName)) return true;
    }
  }
  macVolumePath.lastIndex = 0;
  for (const match of source.matchAll(macVolumePath)) {
    const volumeName = match[1];
    if (volumeName && !placeholderUserNames.has(volumeName)) return true;
  }
  return /[A-Za-z]:\\Users\\[^\\\s"']+\\/u.test(source);
}

export async function runReleaseCheck(projectRoot = process.cwd()): Promise<ReleaseCheckReport> {
  const lines: string[] = [];
  let files: string[];
  try {
    files = await trackedFiles(projectRoot);
  } catch {
    return { ok: false, lines: ["FAIL project must be inside a Git worktree"] };
  }
  const tracked = new Set(files);

  for (const required of requiredFiles) {
    if (!tracked.has(required)) lines.push(`FAIL required open-source file is not tracked: ${required}`);
  }
  for (const file of files) {
    if (forbiddenTrackedPath.test(file)) {
      lines.push(`FAIL generated, private, or media path is tracked: ${file}`);
      continue;
    }
    const path = join(projectRoot, file);
    let details;
    try {
      details = await stat(path);
    } catch {
      continue;
    }
    if (!details.isFile()) continue;
    if (details.size > 5_000_000) {
      lines.push(`FAIL large tracked file requires explicit review: ${file}`);
      continue;
    }
    const content = await readFile(path);
    if (content.includes(0)) {
      if (approvedBinaryAssets.has(file)) continue;
      lines.push(`FAIL binary tracked file requires explicit review: ${file}`);
      continue;
    }
    const source = content.toString("utf8");
    if (possibleCredential.test(source)) lines.push(`FAIL possible credential in ${file}`);
    if (containsMachinePath(source)) lines.push(`FAIL machine-specific absolute path in ${file}`);
  }

  return lines.length === 0
    ? { ok: true, lines: ["PASS open-source release checks"] }
    : { ok: false, lines };
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const report = await runReleaseCheck();
  for (const line of report.lines) console.log(line);
  process.exitCode = report.ok ? 0 : 1;
}
