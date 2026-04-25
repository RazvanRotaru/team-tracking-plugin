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
};

export type AcquireResultDTO = {
  lock_token: string;
  recovered_checkpoint: Checkpoint | null;
};

/**
 * Tool-level orchestration. Each method:
 *   1. Loads current state via the adapter.
 *   2. Runs domain invariants / lock state machine on a pure value.
 *   3. Persists the result through the adapter inside the per-ref mutex.
 */
export class TicketService {
  constructor(
    private readonly adapter: TrackerAdapter,
    private readonly mutex: RefMutex,
    private readonly opts: ServiceOptions,
  ) {}

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
      await this.adapter.updateTicket(ref, update);
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
      // Per design: bump status from Todo → In Progress on acquisition.
      if (current.status === "Todo") {
        const sv = validateStatusForType(current.type, "In Progress");
        if (sv.ok) {
          await this.adapter.updateTicket(ref, { status: "In Progress" });
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
      const r = checkpoint(current.lock, args.lock_token, {
        commit_id: args.commit_id,
        update: args.update ?? null,
        progress_summary: args.progress_summary ?? null,
        at: this.opts.now(),
      });
      if (!r.ok) return r;
      await this.adapter.writeLock(ref, r.value);
      // The visible TicketDTO progress fields mirror the latest checkpoint.
      await this.adapter.writeProgress(ref, {
        update: args.update ?? current.update ?? null,
        progress_summary: args.progress_summary ?? current.progress_summary ?? null,
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
      await this.adapter.writeLock(ref, null);
      await this.adapter.updateTicket(ref, { status: args.final_status });
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
      if (args.status !== undefined) {
        const sv = validateStatusForType(current.type, args.status);
        if (!sv.ok) return sv;
        await this.adapter.updateTicket(ref, { status: args.status });
      }
      if (args.update !== undefined || args.progress_summary !== undefined) {
        await this.adapter.writeProgress(ref, {
          update: args.update ?? current.update ?? null,
          progress_summary: args.progress_summary ?? current.progress_summary ?? null,
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
      return ok(undefined);
    });
  }

  // ── steering channel ──────────────────────────────────────────────
  // Plugin-agnostic, bidirectional async messaging on the ticket itself.
  // Orchestrator nudges → executor reads at each checkpoint cycle → executor
  // ACKs / replies → orchestrator reads on its next sweep. No lock required;
  // either party may post. Per-ref mutex keeps file writes atomic.

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
      return ok(message);
    });
  }

  async readMessages(ref: TicketRef, since?: string): Promise<Result<Message[], DomainError>> {
    const current = await this.adapter.getTicket(ref);
    if (!current) return err(domainErr("ENOTFOUND", `ticket ${ref.id} not found`));
    return ok(await this.adapter.readMessages(ref, since));
  }
}
