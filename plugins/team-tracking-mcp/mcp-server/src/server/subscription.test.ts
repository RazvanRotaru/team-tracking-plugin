import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";
import type { Event, TicketRef } from "../domain/types.js";
import { Subscription, type SubscriptionEnvelope } from "./subscription.js";

describe("Subscription (Obsidian fs.watch)", () => {
  let dir: string;
  let adapter: ObsidianKanbanAdapter;
  let ref: TicketRef;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-sub-"));
    adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    ref = await adapter.createTicket("P", { type: "task", title: "X" });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("drains buffered events that match `since` then ends on timeout when nothing new arrives", async () => {
    // Append two events before subscribing — the first older than the cursor.
    const oldEv: Event = {
      id: "evt_old",
      at: "2026-04-25T09:00:00Z",
      type: "log",
      by: null,
      line: "ancient",
    };
    const recentEv: Event = {
      id: "evt_recent",
      at: "2026-04-25T11:00:00Z",
      type: "log",
      by: null,
      line: "fresh",
    };
    await adapter.appendEvent(ref, oldEv);
    await adapter.appendEvent(ref, recentEv);

    const sub = new Subscription(
      adapter,
      { project: "P", ticket: ref },
      { since: "2026-04-25T10:00:00Z", timeoutMs: 200 },
    );
    const collected: SubscriptionEnvelope[] = [];
    for await (const env of sub.stream()) collected.push(env);

    const eventsEnvs = collected.filter((e) => e.type === "events");
    expect(eventsEnvs.length).toBeGreaterThanOrEqual(1);
    const ids = eventsEnvs.flatMap((e) => (e.type === "events" ? e.events.map((ev) => ev.id) : []));
    expect(ids).toContain("evt_recent");
    expect(ids).not.toContain("evt_old");

    expect(collected.at(-1)?.type).toBe("timeout");
  });

  it("project-wide drain groups events by ref, one envelope per ticket", async () => {
    const refA = ref;
    const refB = await adapter.createTicket("P", { type: "task", title: "Y" });
    await adapter.appendEvent(refA, {
      id: "evt_a1",
      at: "2026-04-25T10:00:00Z",
      type: "log",
      by: null,
      line: "from A",
    });
    await adapter.appendEvent(refB, {
      id: "evt_b1",
      at: "2026-04-25T10:01:00Z",
      type: "log",
      by: null,
      line: "from B",
    });
    await adapter.appendEvent(refA, {
      id: "evt_a2",
      at: "2026-04-25T10:02:00Z",
      type: "log",
      by: null,
      line: "from A again",
    });

    const sub = new Subscription(adapter, { project: "P" }, { timeoutMs: 200 });
    const collected: SubscriptionEnvelope[] = [];
    for await (const env of sub.stream()) collected.push(env);

    const eventsEnvs = collected.filter(
      (e): e is Extract<SubscriptionEnvelope, { type: "events" }> => e.type === "events",
    );
    // One envelope per ref, with the ref correctly attributed.
    const byRef = new Map(eventsEnvs.map((e) => [e.ref.id, e.events.map((ev) => ev.id)]));
    expect(byRef.get(refA.id)).toEqual(["evt_a1", "evt_a2"]);
    expect(byRef.get(refB.id)).toEqual(["evt_b1"]);
  });

  it("delivers a live event appended after subscribe via fs.watch", async () => {
    const sub = new Subscription(adapter, { project: "P", ticket: ref }, { timeoutMs: 5000 });
    const iter = sub.stream();

    // Kick off consumption asynchronously, capture the first events envelope.
    const firstEnv = (async () => {
      for await (const env of iter) {
        if (env.type === "events") return env;
        if (env.type === "timeout") return env;
      }
      return null;
    })();

    // Give fs.watch a moment to register before we write.
    await new Promise((r) => setTimeout(r, 50));

    const live: Event = {
      id: "evt_live",
      at: new Date().toISOString(),
      type: "message",
      from: "orchestrator",
      kind: "nudge",
      body: "hi",
      in_reply_to: null,
    };
    await adapter.appendEvent(ref, live);

    const env = await firstEnv;
    sub.cancel();
    expect(env?.type).toBe("events");
    if (env?.type !== "events") return;
    expect(env.events.map((e) => e.id)).toContain("evt_live");
  });
});
