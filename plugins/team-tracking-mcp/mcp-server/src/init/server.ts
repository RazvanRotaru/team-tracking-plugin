import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureGitignored, isGitRepo } from "../config/gitignore.js";
import { type Config, ConfigSchema, defaultConfigPath, saveConfig } from "../config/loader.js";

const STATIC_DIR_REL = "web"; // resolved relative to this file at runtime
const SAVE_PATH = "/save";
const ROOT_PATH = "/";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export type InitWebResult = {
  configPath: string;
  config: Config;
  gitignoreUpdated: boolean | null;
};

function staticDir(): string {
  // Both in dev (tsx) and prod (compiled), the web/ folder ships next to this
  // file. Resolve via import.meta.url to stay portable.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), STATIC_DIR_REL);
}

async function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function pickContentType(filePath: string): string {
  return MIME[path.extname(filePath)] ?? "application/octet-stream";
}

export type RunInitWebOpts = {
  configPath?: string;
  /** When true, no browser is launched; URL is just printed. */
  noBrowser?: boolean;
  onUrl?: (url: string) => void;
  /** Override of repo root for gitignore detection (defaults to dirname(dirname(configPath))). */
  repoRoot?: string;
  /**
   * Interface to bind on. Default `127.0.0.1` — single-machine flow. Pass a
   * routable address (LAN / Tailscale IP, or `0.0.0.0`) to make the page
   * reachable from another host. Token auth still applies; the Host-header
   * check is relaxed when bound away from localhost.
   */
  host?: string;
};

/**
 * Boot the local HTTP server and resolve once the user has POSTed a config.
 */
export async function runInitWeb(opts: RunInitWebOpts = {}): Promise<InitWebResult> {
  const token = randomBytes(24).toString("base64url");
  const target = opts.configPath ?? defaultConfigPath();
  const bindHost = opts.host ?? "127.0.0.1";
  const isLocalhost = bindHost === "127.0.0.1" || bindHost === "localhost";

  let resolveResult: (r: InitWebResult) => void;
  let rejectResult: (e: Error) => void;
  const result = new Promise<InitWebResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = http.createServer(async (req, res) => {
    try {
      // When bound to localhost, also enforce a localhost Host header as
      // belt-and-suspenders. When bound to a routable address the user has
      // explicitly opened the door; we trust the token alone.
      if (isLocalhost) {
        const host = req.headers.host ?? "";
        if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
          res.writeHead(403).end("forbidden");
          return;
        }
      }
      const host = req.headers.host ?? bindHost;

      const url = new URL(req.url ?? "/", `http://${host}`);
      const submittedToken = url.searchParams.get("t") ?? req.headers["x-token"];
      if (submittedToken !== token) {
        res.writeHead(401).end("bad token");
        return;
      }

      if (req.method === "GET") {
        const file = url.pathname === ROOT_PATH ? "/index.html" : url.pathname;
        const safe = path.normalize(file).replace(/^[/\\]+/, "");
        if (safe.includes("..")) {
          res.writeHead(400).end("bad path");
          return;
        }
        const full = path.join(staticDir(), safe);
        const body = await fs.readFile(full);
        res.writeHead(200, { "content-type": pickContentType(full) }).end(body);
        return;
      }

      if (req.method === "POST" && url.pathname === SAVE_PATH) {
        const buf = await readBody(req);
        const json = JSON.parse(buf.toString("utf8"));
        const config = ConfigSchema.parse(json);
        const writtenPath = await saveConfig(config, target);
        let gitignoreUpdated: boolean | null = null;
        const repoRoot = opts.repoRoot ?? path.dirname(path.dirname(writtenPath));
        if (await isGitRepo(repoRoot)) {
          const gi = await ensureGitignored(repoRoot);
          gitignoreUpdated = gi.changed;
        }
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, configPath: writtenPath }));
        // Resolve after the response has been flushed.
        setImmediate(() => {
          server.close(() => resolveResult({ configPath: writtenPath, config, gitignoreUpdated }));
        });
        return;
      }

      res.writeHead(404).end("not found");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.writeHead(400).end(msg);
    }
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, bindHost, () => res());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("failed to bind init server");
  }
  // For 0.0.0.0 the URL needs a routable host, not the wildcard. Fall back
  // to localhost — the user can substitute whatever IP they reach the
  // machine on. For an explicit IP/hostname, use it as-is.
  const urlHost = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  const url = `http://${urlHost}:${addr.port}/?t=${token}`;
  opts.onUrl?.(url);
  if (!opts.noBrowser) {
    void openBrowser(url).catch(() => {
      // Best effort: fall back to printing the URL.
      process.stdout.write(`open this URL to finish setup: ${url}\n`);
    });
  }

  // Auto-cancel after 30 minutes of inactivity to avoid orphaned processes.
  const cancelTimer = setTimeout(() => {
    server.close();
    rejectResult(new Error("init timed out (no submission within 30m)"));
  }, 30 * 60_000);
  cancelTimer.unref();

  return result;
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  spawn(cmd[0] ?? "", cmd.slice(1), { detached: true, stdio: "ignore" }).unref();
}
