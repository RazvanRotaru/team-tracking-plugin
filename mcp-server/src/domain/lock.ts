import { type DomainError, domainErr } from "./errors.js";
import { type Result, err, ok } from "./result.js";
import type { Checkpoint, Lock, LockState } from "./types.js";

export type AcquireResult = {
  nextLock: Lock;
  recoveredCheckpoint: Checkpoint | null;
};

function lastActivityMs(lock: Lock): number {
  const acquired = Date.parse(lock.acquired_at);
  if (lock.last_checkpoint) {
    return Math.max(acquired, Date.parse(lock.last_checkpoint.at));
  }
  return acquired;
}

export function isStale(lock: Lock, nowIso: string, ttlSeconds: number): boolean {
  return Date.parse(nowIso) - lastActivityMs(lock) > ttlSeconds * 1000;
}

/**
 * Acquire a lock.
 *
 * Cases:
 *  - free (`currentLock == null`): mint new lock, no recovery.
 *  - stale: replace lock; surface previous `last_checkpoint` as `recoveredCheckpoint`.
 *  - live: ELOCKED.
 */
export function acquire(
  currentLock: Lock | null,
  owner: string,
  token: string,
  nowIso: string,
  ttlSeconds: number,
): Result<AcquireResult, DomainError> {
  if (currentLock === null) {
    return ok({
      nextLock: { owner, token, acquired_at: nowIso, last_checkpoint: null },
      recoveredCheckpoint: null,
    });
  }

  if (isStale(currentLock, nowIso, ttlSeconds)) {
    return ok({
      nextLock: { owner, token, acquired_at: nowIso, last_checkpoint: null },
      recoveredCheckpoint: currentLock.last_checkpoint,
    });
  }

  return err(domainErr("ELOCKED", `ticket is locked by ${currentLock.owner}`));
}

export function checkpoint(
  currentLock: Lock | null,
  token: string,
  cp: {
    commit_id: string;
    update?: string | null;
    progress_summary?: string | null;
    at: string;
  },
): Result<Lock, DomainError> {
  if (currentLock === null) {
    return err(domainErr("ENOTLOCKED", "no lock held on this ticket"));
  }
  if (currentLock.token !== token) {
    return err(domainErr("EBADTOKEN", "lock token does not match the active lock"));
  }
  return ok({
    ...currentLock,
    last_checkpoint: {
      commit_id: cp.commit_id,
      update: cp.update ?? null,
      progress_summary: cp.progress_summary ?? null,
      at: cp.at,
    },
  });
}

export function release(currentLock: Lock | null, token: string): Result<void, DomainError> {
  if (currentLock === null) {
    return err(domainErr("ENOTLOCKED", "no lock held on this ticket"));
  }
  if (currentLock.token !== token) {
    return err(domainErr("EBADTOKEN", "lock token does not match the active lock"));
  }
  return ok(undefined);
}

export function reportProgress(currentLock: Lock | null, token: string): Result<Lock, DomainError> {
  if (currentLock === null) {
    return err(domainErr("ENOTLOCKED", "no lock held on this ticket"));
  }
  if (currentLock.token !== token) {
    return err(domainErr("EBADTOKEN", "lock token does not match the active lock"));
  }
  return ok(currentLock);
}

export function deriveLockState(lock: Lock | null): LockState {
  if (lock === null) return "free";
  if (lock.last_checkpoint) return "committed";
  return "in_progress";
}
