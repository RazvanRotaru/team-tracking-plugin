import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Cross-process advisory lock for the shared board.md.
 *
 * The shared board is read-modify-written by every MCP server that opts a
 * project into shared-board mode. Two servers can race on the file; the
 * within-process `RefMutex` doesn't help. We serialise writes by acquiring
 * an exclusive lockfile (`O_EXCL` open) before each read-modify-write
 * cycle.
 *
 * **This is best-effort, not linearizable.** A crashed holder leaves a
 * stale lockfile that the next acquirer will steal after `STALE_TTL_MS`.
 * If you need strict serialization, run a single MCP server.
 */

const STALE_TTL_MS = 30_000;
const MAX_RETRY_MS = 5_000;
const RETRY_BACKOFF_BASE_MS = 50;
const RETRY_BACKOFF_MAX_MS = 500;

export type LockHandle = {
  release: () => Promise<void>;
};

type LockMetadata = {
  pid: number;
  hostname: string;
  acquiredAt: string;
};

async function tryCreate(lockfilePath: string): Promise<boolean> {
  await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
  const meta: LockMetadata = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  try {
    const handle = await fs.open(lockfilePath, "wx");
    try {
      await handle.writeFile(JSON.stringify(meta), "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

async function isStale(lockfilePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockfilePath);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > STALE_TTL_MS;
  } catch {
    return false;
  }
}

async function stealIfStable(lockfilePath: string): Promise<boolean> {
  // Re-stat after a short delay; only steal if mtime didn't change, so we
  // don't yank the lock from a live but slow holder.
  let before: number;
  try {
    before = (await fs.stat(lockfilePath)).mtimeMs;
  } catch {
    return true; // disappeared on its own
  }
  await sleep(50);
  let after: number;
  try {
    after = (await fs.stat(lockfilePath)).mtimeMs;
  } catch {
    return true;
  }
  if (after !== before) return false;
  try {
    await fs.unlink(lockfilePath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireLock(lockfilePath: string): Promise<LockHandle> {
  const deadline = Date.now() + MAX_RETRY_MS;
  let backoff = RETRY_BACKOFF_BASE_MS;
  let stealAttempted = false;

  while (true) {
    if (await tryCreate(lockfilePath)) {
      return {
        release: async () => {
          try {
            await fs.unlink(lockfilePath);
          } catch {
            // The lockfile was stolen by a stale-takeover. Releasing is a
            // no-op then; whoever stole it owns it now.
          }
        },
      };
    }

    // Proactively steal a stale lockfile on the first contended attempt so
    // we don't burn the entire retry budget waiting on a ghost.
    if (!stealAttempted && (await isStale(lockfilePath))) {
      stealAttempted = true;
      if (await stealIfStable(lockfilePath)) continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `failed to acquire shared-board lock at ${lockfilePath} within ${MAX_RETRY_MS}ms`,
      );
    }

    await sleep(backoff);
    backoff = Math.min(backoff * 2, RETRY_BACKOFF_MAX_MS);
  }
}

export async function withLock<T>(lockfilePath: string, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireLock(lockfilePath);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
