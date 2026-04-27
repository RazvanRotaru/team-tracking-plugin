import type {
  CreateTicketDTO,
  Event,
  Lock,
  Message,
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
 * Watcher subscription. Adapters that can push (Obsidian fs.watch, Jira
 * webhook receiver) implement `watch()`; pollers implement it on top of
 * polling. The broker treats them all the same.
 */
export type WatcherUnsubscribe = () => Promise<void>;
export type WatcherCallback = (ref: TicketRef, events: Event[]) => void;

/**
 * Neutral interface every backend implements.
 *
 * Atomicity contract: the server holds a per-`TicketRef` mutex around every
 * mutation. Adapters can assume there are no concurrent calls for the same
 * ref, but must assume calls for *different* refs may overlap.
 *
 * Event-log contract: every state change is recorded by the service as an
 * `Event` and persisted via `appendEvent`. The canonical scalar fields
 * (`update`, `progress_summary`, `lock`) are stored on the ticket as a
 * read cache; adapters update them in the same write as the corresponding
 * event so the cache never lags the log within a single mutation.
 */
export interface TrackerAdapter {
  init(config: AdapterConfig): Promise<void>;

  listBoard(project: string): Promise<TicketSummaryDTO[]>;
  getTicket(ref: TicketRef): Promise<TicketDTO | null>;
  listChildren(ref: TicketRef): Promise<TicketDTO[]>;

  createTicket(project: string, draft: CreateTicketDTO): Promise<TicketRef>;
  updateTicket(ref: TicketRef, update: UpdateDTO): Promise<void>;

  /** Persist the canonical lock cache alongside the corresponding event. */
  writeLock(ref: TicketRef, lock: Lock | null): Promise<void>;

  /** Persist the canonical progress cache alongside the corresponding event. */
  writeProgress(
    ref: TicketRef,
    progress: { update: string | null; progress_summary: string | null },
  ): Promise<void>;

  /**
   * Append a single event to the ticket's append-only log. The server is
   * responsible for minting `id` and `at`; adapters store the record verbatim.
   */
  appendEvent(ref: TicketRef, event: Event): Promise<void>;

  /**
   * Read the event log for a ticket. If `since` is set, only events with
   * `at > since` are returned (string compare on ISO-8601 is monotonic, so
   * this is well-defined). Optional `types` filters to a subset.
   */
  readEvents(
    ref: TicketRef,
    opts?: { since?: string; types?: ReadonlyArray<Event["type"]> },
  ): Promise<Event[]>;

  /**
   * Project-level scan for newly-arrived events. Optional; if not
   * implemented (returns null), the broker falls back to per-ticket reads.
   * Used by the broker to deliver project-wide subscriptions efficiently.
   */
  readProjectEvents?(
    project: string,
    opts?: { since?: string; types?: ReadonlyArray<Event["type"]> },
  ): Promise<Array<{ ref: TicketRef; event: Event }>>;

  /**
   * Subscribe to push notifications. Adapters that natively support push
   * (Obsidian fs.watch, Jira webhook receiver) wire this up; adapters
   * without push can omit it and the broker will poll instead.
   */
  watch?(project: string, callback: WatcherCallback): Promise<WatcherUnsubscribe>;

  /**
   * Legacy projections kept for back-compat with `read_messages` /
   * post_message tools. Both are derivable from `readEvents` filtered to
   * `message`, but adapters may have a faster path.
   */
  postMessage(ref: TicketRef, message: Message): Promise<void>;
  readMessages(ref: TicketRef, since?: string): Promise<Message[]>;

  /**
   * Append a free-text audit line. Service emits a `log` event for the same
   * call so it appears in the unified stream, but adapters retain this for
   * back-compat with existing tooling and for adapter-native log surfaces
   * (Jira issue comments, Obsidian `## Log` section).
   */
  appendLog(ref: TicketRef, line: string): Promise<void>;
}
