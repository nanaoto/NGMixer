import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const executeFile = promisify(execFile);

export interface FfmpegBridgeOptions {
  readonly host: "127.0.0.1" | "::1" | "localhost";
  readonly port: number;
  readonly token: string;
  readonly allowedRoot: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export interface FfmpegBridgeResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type ExecutionRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; maxBuffer: number; encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

const defaultRunner: ExecutionRunner = async (executable, args, options) =>
  await executeFile(executable, args, options);

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function hasValidToken(request: IncomingMessage, expected: string): boolean {
  const supplied = request.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const left = Buffer.from(supplied.slice(7));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function realPathOrExistingParent(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(candidate, "..");
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function validateArgument(argument: unknown, allowedRoot: string): Promise<string> {
  if (typeof argument !== "string" || argument.length > 8_192 || argument.includes("\0")) {
    throw new Error("FFmpeg arguments must be bounded strings");
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(argument)) {
    throw new Error("FFmpeg protocol URLs are not allowed");
  }
  if (isAbsolute(argument)) {
    const candidate = resolve(argument);
    const [realRoot, realCandidate] = await Promise.all([
      realpath(resolve(allowedRoot)),
      realPathOrExistingParent(candidate),
    ]);
    const relation = relative(realRoot, realCandidate);
    if (relation.startsWith("..") || isAbsolute(relation)) {
      throw new Error("FFmpeg file path is outside the allowed root");
    }
  } else if (argument.includes("/") || argument.includes("\\") || argument.split(/[\\/]/u).includes("..")) {
    throw new Error("relative FFmpeg file paths are not allowed");
  }
  return argument;
}

export async function executeFfmpegBridgeRequest(
  authorization: string | undefined,
  body: unknown,
  options: FfmpegBridgeOptions,
  runner: ExecutionRunner = defaultRunner,
): Promise<FfmpegBridgeResult> {
  const request = { headers: { authorization } } as IncomingMessage;
  if (!hasValidToken(request, options.token)) {
    return { status: 401, body: { ok: false, error: "unauthorized" } };
  }
  try {
    const command = body as { tool?: unknown; args?: unknown };
    if (command.tool !== "ffmpeg" && command.tool !== "ffprobe") throw new Error("tool must be ffmpeg or ffprobe");
    if (!Array.isArray(command.args) || command.args.length > 256) throw new Error("args must be a bounded array");
    const args = await Promise.all(command.args.map(
      async (argument) => await validateArgument(argument, options.allowedRoot),
    ));
    const executable = command.tool === "ffmpeg" ? options.ffmpegPath : options.ffprobePath;
    const result = await runner(executable, args, {
      cwd: options.allowedRoot,
      timeout: options.timeoutMs ?? 180_000,
      maxBuffer: options.maxBufferBytes ?? 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return { status: 200, body: { ok: true, stdout: result.stdout, stderr: result.stderr } };
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
    return {
      status: failure.code === undefined ? 400 : 500,
      body: {
        ok: false,
        error: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      },
    };
  }
}

export class FfmpegBridgeServer {
  readonly #options: FfmpegBridgeOptions;
  #server: Server | undefined;

  public constructor(options: FfmpegBridgeOptions) {
    if (options.token.length < 32) throw new Error("FFmpeg bridge token must contain at least 32 characters");
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error("FFmpeg bridge port is invalid");
    }
    this.#options = options;
  }

  public async start(): Promise<{ host: string; port: number }> {
    if (this.#server) throw new Error("FFmpeg bridge is already running");
    const server = createServer((request, response) => { void this.#handle(request, response); });
    this.#server = server;
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("FFmpeg bridge did not expose a TCP address");
    return { host: this.#options.host, port: address.port };
  }

  public async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!hasValidToken(request, this.#options.token)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/exec") {
      sendJson(response, 404, { ok: false, error: "not found" });
      return;
    }
    try {
      const result = await executeFfmpegBridgeRequest(
        request.headers.authorization,
        await readJson(request),
        this.#options,
      );
      sendJson(response, result.status, result.body);
    } catch (error) {
      const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string };
      const status = failure.code === undefined ? 400 : 500;
      sendJson(response, status, {
        ok: false,
        error: failure.message,
        ...(failure.code === undefined ? {} : { code: failure.code }),
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
      });
    }
  }
}

async function main(): Promise<void> {
  const token = process.env.RMA_FFMPEG_BRIDGE_TOKEN ??
    (process.env.RMA_FFMPEG_BRIDGE_TOKEN_FILE
      ? (await readFile(process.env.RMA_FFMPEG_BRIDGE_TOKEN_FILE, "utf8")).trim()
      : undefined);
  const allowedRoot = process.env.RMA_FFMPEG_ALLOWED_ROOT;
  if (!token || !allowedRoot) throw new Error("RMA_FFMPEG_BRIDGE_TOKEN and RMA_FFMPEG_ALLOWED_ROOT are required");
  const server = new FfmpegBridgeServer({
    host: "127.0.0.1",
    port: Number.parseInt(process.env.RMA_FFMPEG_BRIDGE_PORT ?? "32281", 10),
    token,
    allowedRoot,
    ffmpegPath: process.env.RMA_FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg",
    ffprobePath: process.env.RMA_FFPROBE_PATH ?? "/opt/homebrew/bin/ffprobe",
  });
  const address = await server.start();
  console.log(`FFmpeg bridge listening on http://${address.host}:${address.port}`);
  process.once("SIGINT", () => { void server.close(); });
  process.once("SIGTERM", () => { void server.close(); });
}

const entryPoint = process.argv[1];
if (process.env.RMA_FFMPEG_BRIDGE_AUTOSTART === "1" ||
    (entryPoint && import.meta.url === pathToFileURL(entryPoint).href)) await main();
