import type { TrackerAdapter } from "../adapters/types.js";
import { type DomainError, domainErr } from "../domain/errors.js";
import { validateCreate, validateStatusForType, validateUpdate } from "../domain/invariants.js";
import {
  acquire,
  checkpoint,
  release,
  reportProgress as reportProgressLock,
} from "../domain/lock.js";
import { type Result, err, ok } from "../domain/result.js";
import type {
  Checkpoint,
  CommitCheckpointDTO,
  CreateTicketDTO,
  Event,
  Message,
  PostMessageDTO,
  ReportProgressDTO,
  TicketDTO,
  TicketRef,
  TicketSummaryDTO,
  UpdateDTO,
} from "../domain/types.js";
import type { RefMutex } from "./mutex.js";

export type ServiceOptions = {
  ttlSeconds: number;
  now: () => string;
  mintToken: () => string;
  mintMessageId: () => string;
  mintEventId: () => string;
};

export type AcquireResultDTO = {
  lock_token: string;
  recovered_checkpoint: Checkpoint | null;
};

/** Hook for the broker to receive every event the service emits. */
export type EventEmitter = (ref: TicketRef, event: Event) => void;

/**
 * Tool-level orchestration. Each method:
 *   1. Loads current state via the adapter.
 *   2. Runs domain invariants / lock state machine on a pure value.
 *   3. Persists the result through the adapter inside the per-ref mutex.
 *   4. Appends one or more events to the ticket's append-only log.
 *   5. Notifies the broker so subscribers see the events live.
 *
 * Steps (3) and (4) are not transactional — they run sequentially under the
 * per-ref mutex. Crash-recovery: the event log is the audit-canonical
 * surface; the cached scalar fields can be rebuilt from it.
 */
export class TicketService {
  private emitters: EventEmitter[] = [];

  constructor(
    private readonly adapter: TrackerAdapter,
    private readonly mutex: RefMutex,
    private readonly opts: ServiceOptions,
  ) {}

  onEvent(emitter: EventEmitter): void {
    this.emitters.push(emitter);
  }

  private mintEvent(): { id: string; at: string } {
    return { id: this.opts.mintEventId(), at: this.opts.now() };
  }

  private async record(ref: TicketRef, event: Event): Promise<void> {
    await this.adapter.appendEvent(ref, event);
    for (const e of this.emitters) {
      try {
        e(ref, event);
      } catch {
        // Emitters must never throw — broker is best-effort.
      }
    }
  }

  // ── reads ──────────────────────────────────────────────────────────

  listBoard(project: string): Promise<TicketSummaryDTO[]> {
    return this.adapter.listBoard(project);
  }

  getTicket(ref: TicketRef): Promise<TicketDTO | null> {
    return this.adapter.getTicket(ref);
  }

  listChildren(ref: TicketRef): Promise<TicketDTO[]> {
    return this.adapter.listChildren(ref);
  }

  async readEvents(
    ref: TicketRef,
    opts?: { since?: string; types?: ReadonlyArray<Event["type"]> },
  ): Promise<Result<Event[], DomainError>> {
    const current = await this.adapter.getTicket(ref);
    if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
    return ok(await this.adapter.readEvents(ref, opts));
  }

  // ── orchestrator writes ────────────────────────────────────────────

  async createTicket(
    project: string,
    draft: CreateTicketDTO,
  ): Promise<Result<TicketRef, DomainError>> {
    const parent = draft.parent ? await this.adapter.getTicket(draft.parent) : null;
    if (draft.parent && !parent) {
      return err(domainErr("ENOTFOUND", `parent ticket ${draft.parent.id} not found`));
    }
    const v = validateCreate({ type: draft.type }, parent ? { type: parent.type } : null);
    if (!v.ok) return v;
    const ref = await this.adapter.createTicket(project, draft);
    return ok(ref);
  }

  async updateTicket(ref: TicketRef, update: UpdateDTO): Promise<Result<void, DomainError>> {
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      const v = validateUpdate(current, update as never);
      if (!v.ok) return v;
      if (update.status !== undefined) {
        const sv = validateStatusForType(current.type, update.status);
        if (!sv.ok) return sv;
      }
      const wasStatus = current.status;
      await this.adapter.updateTicket(ref, update);
      if (update.status !== undefined && update.status !== wasStatus) {
        const ev = this.mintEvent();
        await this.record(ref, {
          ...ev,
          type: "status_change",
          by: null,
          from_status: wasStatus,
          to_status: update.status,
        });
      }
      return ok(undefined);
    });
  }

  // ── specialist (lock-bound) writes ─────────────────────────────────

  async acquireTicket(
    ref: TicketRef,
    owner: string,
  ): Promise<Result<AcquireResultDTO, DomainError>> {
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      const token = this.opts.mintToken();
      const r = acquire(current.lock, owner, token, this.opts.now(), this.opts.ttlSeconds);
      if (!r.ok) return r;
      await this.adapter.writeLock(ref, r.value.nextLock);

      const recovered = r.value.recoveredCheckpoint;
      const ev = this.mintEvent();
      await this.record(ref, {
        ...ev,
        type: "lock_change",
        action: recovered ? "recover" : "acquire",
        owner,
        recovered_from: recovered ? (current.lock?.owner ?? null) : null,
        final_status: null,
      });

      // Per design: bump status from Todo → In Progress on acquisition.
      if (current.status === "Todo") {
        const sv = validateStatusForType(current.type, "In Progress");
        if (sv.ok) {
          await this.adapter.updateTicket(ref, { status: "In Progress" });
          const ev2 = this.mintEvent();
          await this.record(ref, {
            ...ev2,
            type: "status_change",
            by: owner,
            from_status: "Todo",
            to_status: "In Progress",
          });
        }
      }
      return ok({
        lock_token: token,
        recovered_checkpoint: r.value.recoveredCheckpoint,
      });
    });
  }

  async commitCheckpoint(
    ref: TicketRef,
    args: { lock_token: string } & CommitCheckpointDTO,
  ): Promise<Result<void, DomainError>> {
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      // Compose post-state: an unspecified field carries forward the
      // current value, an explicitly-null field clears it. This is the
      // value the cache must reflect after the call, so it's also what
      // the event records.
      const newUpdate = args.update !== undefined ? args.update : (current.update ?? null);
      const newProgressSummary =
        args.progress_summary !== undefined
          ? args.progress_summary
          : (current.progress_summary ?? null);
      const r = checkpoint(current.lock, args.lock_token, {
        commit_id: args.commit_id,
        update: newUpdate,
        progress_summary: newProgressSummary,
        at: this.opts.now(),
      });
      if (!r.ok) return r;
      await this.adapter.writeLock(ref, r.value);

      const owner = current.lock?.owner ?? "";
      const ev = this.mintEvent();
      await this.record(ref, {
        ...ev,
        type: "checkpoint",
        by: owner,
        commit_id: args.commit_id,
        update: newUpdate,
        progress_summary: newProgressSummary,
      });
      return ok(undefined);
    });
  }

  async releaseTicket(
    ref: TicketRef,
    args: { lock_token: string; final_status: string },
  ): Promise<Result<void, DomainError>> {
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      const r = release(current.lock, args.lock_token);
      if (!r.ok) return r;
      const sv = validateStatusForType(current.type, args.final_status);
      if (!sv.ok) return sv;
      const owner = current.lock?.owner ?? "";
      const wasStatus = current.status;
      await this.adapter.writeLock(ref, null);
      await this.adapter.updateTicket(ref, { status: args.final_status });

      const evRel = this.mintEvent();
      await this.record(ref, {
        ...evRel,
        type: "lock_change",
        action: "release",
        owner,
        recovered_from: null,
        final_status: args.final_status,
      });
      if (args.final_status !== wasStatus) {
        const evSt = this.mintEvent();
        await this.record(ref, {
          ...evSt,
          type: "status_change",
          by: owner,
          from_status: wasStatus,
          to_status: args.final_status,
        });
      }
      return ok(undefined);
    });
  }

  async reportProgress(
    ref: TicketRef,
    args: { lock_token: string } & ReportProgressDTO,
  ): Promise<Result<void, DomainError>> {
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      const r = reportProgressLock(current.lock, args.lock_token);
      if (!r.ok) return r;
      const owner = current.lock?.owner ?? "";
      const wasStatus = current.status;
      if (args.status !== undefined) {
        const sv = validateStatusForType(current.type, args.status);
        if (!sv.ok) return sv;
        await this.adapter.updateTicket(ref, { status: args.status });
      }
      // Compose post-state for update / progress_summary so the event
      // records what the cache should look like after this call.
      const newUpdate = args.update !== undefined ? args.update : (current.update ?? null);
      const newProgressSummary =
        args.progress_summary !== undefined
          ? args.progress_summary
          : (current.progress_summary ?? null);

      // One progress event per call captures the visible-field deltas.
      const ev = this.mintEvent();
      await this.record(ref, {
        ...ev,
        type: "progress",
        by: owner,
        status: args.status ?? null,
        update: newUpdate,
        progress_summary: newProgressSummary,
      });
      if (args.status !== undefined && args.status !== wasStatus) {
        const evSt = this.mintEvent();
        await this.record(ref, {
          ...evSt,
          type: "status_change",
          by: owner,
          from_status: wasStatus,
          to_status: args.status,
        });
      }
      return ok(undefined);
    });
  }

  async appendLog(ref: TicketRef, line: string): Promise<Result<void, DomainError>> {
    // Not gated on a lock token — anyone may append. Still serialized via
    // the per-ref mutex so the underlying file write is atomic.
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      await this.adapter.appendLog(ref, line);
      const owner = current.lock?.owner ?? null;
      const ev = this.mintEvent();
      await this.record(ref, {
        ...ev,
        type: "log",
        by: owner,
        line,
      });
      return ok(undefined);
    });
  }

  // ── steering channel ──────────────────────────────────────────────
  // Plugin-agnostic, bidirectional async messaging on the ticket itself.
  // Now flows through the unified event log: each post is appended as a
  // `message` event AND mirrored in the legacy message store via
  // adapter.postMessage so older readers still see the steering thread.

  async postMessage(ref: TicketRef, dto: PostMessageDTO): Promise<Result<Message, DomainError>> {
    return this.mutex.withLock(ref, async () => {
      const current = await this.adapter.getTicket(ref);
      if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
      const message: Message = {
        id: this.opts.mintMessageId(),
        at: this.opts.now(),
        from: dto.from,
        kind: dto.kind ?? "info",
        body: dto.body,
        in_reply_to: dto.in_reply_to ?? null,
      };
      await this.adapter.postMessage(ref, message);
      const ev = this.mintEvent();
      await this.record(ref, {
        ...ev,
        type: "message",
        from: message.from,
        kind: message.kind,
        body: message.body,
        in_reply_to: message.in_reply_to,
      });
      return ok(message);
    });
  }

  async readMessages(ref: TicketRef, since?: string): Promise<Result<Message[], DomainError>> {
    const current = await this.adapter.getTicket(ref);
    if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
    return ok(await this.adapter.readMessages(ref, since));
  }
}
