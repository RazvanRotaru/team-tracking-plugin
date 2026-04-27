import type { TrackerAdapter, WatcherUnsubscribe } from "../adapters/types.js";
import type { Event, TicketRef } from "../domain/types.js";

export type SubscriptionScope = { project: string; ticket?: TicketRef };

export type SubscriptionOptions = {
  /** Initial cursor; only events with `at > since` are returned. */
  since?: string;
  /** Filter events to a subset of types. */
  types?: ReadonlyArray<Event["type"]>;
  /** When set, the iterator yields a `{type:"timeout"}` envelope and ends. */
  timeoutMs?: number;
  /** Override clock for tests. */
  now?: () => number;
};

export type SubscriptionEnvelope =
  | { type: "events"; ref: TicketRef; events: Event[] }
  | { type: "timeout" }
  | { type: "error"; reason: string };

/**
 * Drain-then-tail subscription. Yields buffered events first (so a caller
 * with a stale `since` cursor sees missed history immediately), then live
 * events as they arrive via the adapter's `watch`. Ends when the timeout
 * fires or `cancel()` is called.
 *
 * Stateless re: subscribers — the caller passes `since`; this object holds
 * no per-subscriber server-side state. After yielding, the caller advances
 * its own cursor to `max(events.map(e => e.at))` and re-subscribes.
 *
 * Caveat: drain happens once at the start. Subsequent events arrive only
 * via `watch`; if the adapter has no `watch` implementation, the
 * subscription functions as a one-shot "drain or timeout" call.
 */
export class Subscription {
  private cancelled = false;
  private unsubscribe: WatcherUnsubscribe | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private readonly queue: SubscriptionEnvelope[] = [];
  private resolveNext: ((v: IteratorResult<SubscriptionEnvelope>) => void) | null = null;
  private done = false;

  constructor(
    private readonly adapter: TrackerAdapter,
    private readonly scope: SubscriptionScope,
    private readonly opts: SubscriptionOptions = {},
  ) {}

  /**
   * Start the subscription. Returns an async iterator that yields envelopes.
   * Caller is expected to consume the iterator and `return` (or call
   * `cancel`) when done.
   */
  async *stream(): AsyncIterableIterator<SubscriptionEnvelope> {
    // 1. Drain — return any events newer than `since` immediately. This
    // handles the race where a message was posted between the caller's
    // last sweep and this subscribe.
    try {
      const drained = await this.drain();
      if (drained.length > 0) {
        this.enqueue({
          type: "events",
          ref: drained[0]?.ref ?? this.fallbackRef(),
          events: drained.map((d) => d.event),
        });
      }
    } catch (e) {
      this.enqueue({ type: "error", reason: (e as Error).message });
      this.markDone();
      yield* this.flush();
      return;
    }

    // 2. Tail — register the watcher. If the adapter doesn't implement
    // watch, we still honor the timeout (caller may have only cared about
    // the drain pass).
    if (this.adapter.watch && !this.cancelled) {
      try {
        this.unsubscribe = await this.adapter.watch(this.scope.project, (ref, events) => {
          if (this.cancelled) return;
          const filtered = this.applyFilters(events);
          if (filtered.length === 0) return;
          if (this.scope.ticket && this.scope.ticket.id !== ref.id) return;
          this.enqueue({ type: "events", ref, events: filtered });
        });
      } catch (e) {
        this.enqueue({ type: "error", reason: (e as Error).message });
        this.markDone();
      }
    }

    // 3. Timeout — schedules a single envelope and end.
    if (this.opts.timeoutMs && this.opts.timeoutMs > 0 && !this.done) {
      this.timeoutHandle = setTimeout(() => {
        this.enqueue({ type: "timeout" });
        this.markDone();
      }, this.opts.timeoutMs);
    } else if (!this.adapter.watch) {
      // No watcher and no timeout — drain only.
      this.markDone();
    }

    yield* this.flush();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.markDone();
  }

  private async drain(): Promise<Array<{ ref: TicketRef; event: Event }>> {
    const opts = { since: this.opts.since, types: this.opts.types };
    if (this.scope.ticket) {
      const events = await this.adapter.readEvents(this.scope.ticket, opts);
      const ref = this.scope.ticket;
      return events.map((event) => ({ ref, event }));
    }
    if (this.adapter.readProjectEvents) {
      return this.adapter.readProjectEvents(this.scope.project, opts);
    }
    // Fallback: scan board, read each ticket's events. Best-effort and not
    // recursive — the conformance contract lets adapters skip this.
    const summaries = await this.adapter.listBoard(this.scope.project);
    const out: Array<{ ref: TicketRef; event: Event }> = [];
    for (const s of summaries) {
      const evs = await this.adapter.readEvents(s.ref, opts);
      for (const event of evs) out.push({ ref: s.ref, event });
    }
    out.sort((a, b) => a.event.at.localeCompare(b.event.at));
    return out;
  }

  private applyFilters(events: Event[]): Event[] {
    let out = events;
    if (this.opts.since) {
      const since = this.opts.since;
      out = out.filter((e) => e.at > since);
    }
    if (this.opts.types && this.opts.types.length > 0) {
      const allow = new Set<Event["type"]>(this.opts.types);
      out = out.filter((e) => allow.has(e.type));
    }
    return out;
  }

  private fallbackRef(): TicketRef {
    return this.scope.ticket ?? { project: this.scope.project, id: "" };
  }

  private enqueue(env: SubscriptionEnvelope): void {
    if (this.done) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: env, done: false });
    } else {
      this.queue.push(env);
    }
  }

  private markDone(): void {
    if (this.done) return;
    this.done = true;
    if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
    if (this.unsubscribe) {
      void this.unsubscribe().catch(() => {
        // Best-effort cleanup; nothing actionable on cleanup failure.
      });
      this.unsubscribe = null;
    }
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined, done: true });
    }
  }

  private async *flush(): AsyncIterableIterator<SubscriptionEnvelope> {
    while (true) {
      if (this.queue.length > 0) {
        const env = this.queue.shift();
        if (env) yield env;
        continue;
      }
      if (this.done) return;
      const next = await new Promise<IteratorResult<SubscriptionEnvelope>>((resolve) => {
        this.resolveNext = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
