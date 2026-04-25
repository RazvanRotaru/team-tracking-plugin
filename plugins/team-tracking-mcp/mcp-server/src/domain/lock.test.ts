import { describe, expect, it } from "vitest";
import { acquire, checkpoint, deriveLockState, isStale, release, reportProgress } from "./lock.js";
import type { Lock } from "./types.js";

const TTL = 1800; // 30 min
const NOW = "2026-04-24T10:00:00Z";

const liveLock = (overrides: Partial<Lock> = {}): Lock => ({
  owner: "alice",
  token: "tok_old",
  acquired_at: "2026-04-24T09:50:00Z",
  last_checkpoint: null,
  ...overrides,
});

describe("deriveLockState", () => {
  it("returns 'free' when lock is null", () => {
    expect(deriveLockState(null)).toBe("free");
  });

  it("returns 'in_progress' when lock has no checkpoint", () => {
    expect(deriveLockState(liveLock())).toBe("in_progress");
  });

  it("returns 'committed' when lock has a checkpoint", () => {
    expect(
      deriveLockState(
        liveLock({
          last_checkpoint: {
            commit_id: "abc",
            update: null,
            progress_summary: null,
            at: NOW,
          },
        }),
      ),
    ).toBe("committed");
  });
});

describe("isStale", () => {
  it("non-stale within TTL", () => {
    expect(isStale(liveLock(), NOW, TTL)).toBe(false);
  });

  it("stale after TTL since acquired_at", () => {
    expect(isStale(liveLock({ acquired_at: "2026-04-24T08:00:00Z" }), NOW, TTL)).toBe(true);
  });

  it("a recent checkpoint keeps the lock alive even if acquired_at is old", () => {
    const lock = liveLock({
      acquired_at: "2026-04-24T08:00:00Z",
      last_checkpoint: {
        commit_id: "abc",
        update: null,
        progress_summary: null,
        at: "2026-04-24T09:55:00Z",
      },
    });
    expect(isStale(lock, NOW, TTL)).toBe(false);
  });
});

describe("acquire", () => {
  it("from free → mints new lock, no recovery", () => {
    const r = acquire(null, "bob", "tok_new", NOW, TTL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nextLock).toEqual({
      owner: "bob",
      token: "tok_new",
      acquired_at: NOW,
      last_checkpoint: null,
    });
    expect(r.value.recoveredCheckpoint).toBeNull();
  });

  it("live lock by another → ELOCKED", () => {
    const r = acquire(liveLock(), "bob", "tok_new", NOW, TTL);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ELOCKED");
    expect(r.error.message).toContain("alice");
  });

  it("stale lock → replaces, recovers checkpoint", () => {
    const stale = liveLock({
      acquired_at: "2026-04-24T08:00:00Z",
      last_checkpoint: {
        commit_id: "deadbeef",
        update: "wip",
        progress_summary: "halfway",
        at: "2026-04-24T08:05:00Z",
      },
    });
    const r = acquire(stale, "bob", "tok_new", NOW, TTL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nextLock.owner).toBe("bob");
    expect(r.value.nextLock.token).toBe("tok_new");
    expect(r.value.nextLock.last_checkpoint).toBeNull();
    expect(r.value.recoveredCheckpoint?.commit_id).toBe("deadbeef");
  });

  it("stale lock with no checkpoint → recovers null", () => {
    const stale = liveLock({ acquired_at: "2026-04-24T08:00:00Z" });
    const r = acquire(stale, "bob", "tok_new", NOW, TTL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.recoveredCheckpoint).toBeNull();
  });
});

describe("checkpoint", () => {
  it("ENOTLOCKED when lock is null", () => {
    const r = checkpoint(null, "tok", { commit_id: "abc", at: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ENOTLOCKED");
  });

  it("EBADTOKEN when token mismatches", () => {
    const r = checkpoint(liveLock(), "tok_wrong", { commit_id: "abc", at: NOW });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("EBADTOKEN");
  });

  it("in_progress → committed records the checkpoint", () => {
    const r = checkpoint(liveLock(), "tok_old", {
      commit_id: "abc",
      update: "u",
      progress_summary: "ps",
      at: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.last_checkpoint).toEqual({
      commit_id: "abc",
      update: "u",
      progress_summary: "ps",
      at: NOW,
    });
    expect(deriveLockState(r.value)).toBe("committed");
  });

  it("committed → committed (self-loop) overwrites checkpoint", () => {
    const lock = liveLock({
      last_checkpoint: {
        commit_id: "old",
        update: null,
        progress_summary: null,
        at: "2026-04-24T09:55:00Z",
      },
    });
    const r = checkpoint(lock, "tok_old", { commit_id: "new", at: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.last_checkpoint?.commit_id).toBe("new");
  });

  it("missing optional fields default to null", () => {
    const r = checkpoint(liveLock(), "tok_old", { commit_id: "abc", at: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.last_checkpoint?.update).toBeNull();
    expect(r.value.last_checkpoint?.progress_summary).toBeNull();
  });
});

describe("release", () => {
  it("ENOTLOCKED when lock is null", () => {
    const r = release(null, "tok");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ENOTLOCKED");
  });

  it("EBADTOKEN when token mismatches", () => {
    const r = release(liveLock(), "tok_wrong");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("EBADTOKEN");
  });

  it("succeeds with valid token", () => {
    const r = release(liveLock(), "tok_old");
    expect(r.ok).toBe(true);
  });
});

describe("reportProgress", () => {
  it("ENOTLOCKED when lock is null", () => {
    const r = reportProgress(null, "tok");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ENOTLOCKED");
  });

  it("EBADTOKEN when token mismatches", () => {
    const r = reportProgress(liveLock(), "tok_wrong");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("EBADTOKEN");
  });

  it("returns the unchanged lock with valid token", () => {
    const lock = liveLock();
    const r = reportProgress(lock, "tok_old");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(lock);
  });
});
