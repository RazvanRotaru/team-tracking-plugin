import type {
  CreateTicketDTO,
  Lock,
  TicketDTO,
  TicketRef,
  TicketSummaryDTO,
  UpdateDTO,
} from "../domain/types.js";

export type AdapterConfig = Record<string, unknown>;

/**
 * Capability flags. Reserved for future per-adapter feature negotiation
 * (e.g. native CAS support, custom-field availability). Empty in v1.
 */
export type AdapterCapabilities = Record<string, never>;

/**
 * Neutral interface every backend implements.
 *
 * Atomicity contract: the server holds a per-`TicketRef` mutex around every
 * lock/progress call. Adapters can assume there are no concurrent calls for
 * the same ref, but must assume calls for *different* refs may overlap.
 */
export interface TrackerAdapter {
  init(config: AdapterConfig): Promise<void>;

  listBoard(project: string): Promise<TicketSummaryDTO[]>;
  getTicket(ref: TicketRef): Promise<TicketDTO | null>;
  listChildren(ref: TicketRef): Promise<TicketDTO[]>;

  createTicket(project: string, draft: CreateTicketDTO): Promise<TicketRef>;
  updateTicket(ref: TicketRef, update: UpdateDTO): Promise<void>;

  writeLock(ref: TicketRef, lock: Lock | null): Promise<void>;
  writeProgress(
    ref: TicketRef,
    progress: { update: string | null; progress_summary: string | null },
  ): Promise<void>;
  appendLog(ref: TicketRef, line: string): Promise<void>;
}
