import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const plainValue = /^[A-Za-z0-9_./,:@+\-=]*$/u;

export function parseRuntimeEnvironment(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, original] of source.split(/\r?\n/u).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = assignment.indexOf("=");
    if (separator < 1) throw new Error(`runtime environment line ${index + 1} is not an assignment`);
    const name = assignment.slice(0, separator).trim();
    const encoded = assignment.slice(separator + 1).trim();
    if (!environmentName.test(name)) throw new Error(`runtime environment line ${index + 1} has an invalid name`);
    let value: string;
    if ((encoded.startsWith('"') && encoded.endsWith('"')) ||
        (encoded.startsWith("'") && encoded.endsWith("'"))) {
      value = encoded.slice(1, -1);
      if (/[`$\r\n]/u.test(value)) {
        throw new Error(`runtime environment line ${index + 1} has an unsupported value`);
      }
    } else {
      if (!plainValue.test(encoded)) {
        throw new Error(`runtime environment line ${index + 1} has an unsupported value`);
      }
      value = encoded;
    }
    result[name] = value;
  }
  return result;
}

export async function readRuntimeEnvironment(path: string): Promise<Record<string, string>> {
  if (!isAbsolute(path)) throw new Error("runtime environment path must be absolute");
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error("runtime environment must be a regular file, not a symbolic link");
  }
  if ((details.mode & 0o077) !== 0) {
    throw new Error("runtime environment permissions must be 0600");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) {
    throw new Error("runtime environment must be owned by the current user");
  }
  return parseRuntimeEnvironment(await readFile(path, "utf8"));
}

export async function loadRuntimeEnvironment(path: string): Promise<string[]> {
  let values: Record<string, string>;
  try {
    values = await readRuntimeEnvironment(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const loaded: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (process.env[name] !== undefined) continue;
    process.env[name] = value;
    loaded.push(name);
  }
  return loaded;
}
