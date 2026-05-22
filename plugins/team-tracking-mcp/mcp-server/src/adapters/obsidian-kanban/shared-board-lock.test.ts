import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, withLock } from "./shared-board-lock.js";

describe("shared-board-lock", () => {
  let dir: string;
  let lockfilePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-lock-"));
    lockfilePath = path.join(dir, "shared", "board.md.lock");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("acquires and releases a lockfile", async () => {
    const handle = await acquireLock(lockfilePath);
    const exists = await fs.stat(lockfilePath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);
    await handle.release();
    const stillExists = await fs.stat(lockfilePath).then(
      () => true,
      () => false,
    );
    expect(stillExists).toBe(false);
  });

  it("serializes two concurrent acquires", async () => {
    const order: string[] = [];

    const first = withLock(lockfilePath, async () => {
      order.push("A-enter");
      await new Promise((r) => setTimeout(r, 100));
      order.push("A-exit");
    });

    // Start B slightly later so we can guarantee it queues behind A.
    await new Promise((r) => setTimeout(r, 10));
    const second = withLock(lockfilePath, async () => {
      order.push("B-enter");
      order.push("B-exit");
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["A-enter", "A-exit", "B-enter", "B-exit"]);
  });

  it("steals a stale lockfile after its TTL elapses", async () => {
    // Create a lockfile and backdate its mtime well past the stale TTL.
    await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
    await fs.writeFile(
      lockfilePath,
      JSON.stringify({ pid: 99999, hostname: "ghost", acquiredAt: "1970-01-01T00:00:00Z" }),
    );
    const old = new Date(Date.now() - 5 * 60_000);
    await fs.utimes(lockfilePath, old, old);

    const handle = await acquireLock(lockfilePath);
    await handle.release();
  });

  it("release is safe when the lockfile was already stolen", async () => {
    const handle = await acquireLock(lockfilePath);
    // Simulate the steal: another holder unlinks the file.
    await fs.unlink(lockfilePath);
    // Release should not throw.
    await handle.release();
  });
});
