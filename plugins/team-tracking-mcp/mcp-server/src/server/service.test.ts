import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "../adapters/obsidian-kanban/index.js";
import { RefMutex } from "./mutex.js";
import { TicketService } from "./service.js";

describe("TicketService (Obsidian-backed)", () => {
  let dir: string;
  let service: TicketService;
  let nowMs = Date.parse("2026-04-24T10:00:00Z");
  let tokenN = 0;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-svc-"));
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    nowMs = Date.parse("2026-04-24T10:00:00Z");
    tokenN = 0;
    service = new TicketService(adapter, new RefMutex(), {
      ttlSeconds: 1800,
      now: () => new Date(nowMs).toISOString(),
      mintToken: () => `tok_${++tokenN}`,
      mintMessageId: () => `msg_${++tokenN}`,
      mintEventId: () => `evt_${++tokenN}`,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("create epic with a parent → EPARENT", async () => {
    const epic = await service.createTicket("P", { type: "epic", title: "E" });
    expect(epic.ok).toBe(true);
    if (!epic.ok) return;
    const r = await service.createTicket("P", {
      type: "epic",
      title: "E2",
      parent: epic.value,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("EPARENT");
  });

  it("create subtask with no parent → EPARENT", async () => {
    const r = await service.createTicket("P", { type: "subtask", title: "S" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("EPARENT");
  });

  it("update with bad status → ESTATUS", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const r = await service.updateTicket(t.value, { status: "Sideways" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ESTATUS");
  });

  it("acquire → checkpoint → release happy path", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    await service.updateTicket(t.value, { status: "Todo" });

    const acq = await service.acquireTicket(t.value, "alice");
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const token = acq.value.lock_token;
    expect(acq.value.recovered_checkpoint).toBeNull();

    // Status should have flipped Todo → In Progress.
    const afterAcq = await service.getTicket(t.value);
    expect(afterAcq?.status).toBe("In Progress");
    expect(afterAcq?.lock_state).toBe("in_progress");

    nowMs += 60_000;
    const cp = await service.commitCheckpoint(t.value, {
      lock_token: token,
      commit_id: "abc1234",
      update: "halfway",
      progress_summary: "flow drafted",
    });
    expect(cp.ok).toBe(true);

    const afterCp = await service.getTicket(t.value);
    expect(afterCp?.lock_state).toBe("committed");
    expect(afterCp?.update).toBe("halfway");
    expect(afterCp?.progress_summary).toBe("flow drafted");
    expect(afterCp?.lock?.last_checkpoint?.commit_id).toBe("abc1234");

    nowMs += 60_000;
    const rel = await service.releaseTicket(t.value, {
      lock_token: token,
      final_status: "Done",
    });
    expect(rel.ok).toBe(true);

    const afterRel = await service.getTicket(t.value);
    expect(afterRel?.status).toBe("Done");
    expect(afterRel?.lock).toBeNull();
    expect(afterRel?.lock_state).toBe("free");
  });

  it("commit without acquire → ENOTLOCKED", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const r = await service.commitCheckpoint(t.value, {
      lock_token: "tok_x",
      commit_id: "abc",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ENOTLOCKED");
  });

  it("commit with wrong token → EBADTOKEN", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    await service.acquireTicket(t.value, "alice");
    const r = await service.commitCheckpoint(t.value, {
      lock_token: "tok_wrong",
      commit_id: "abc",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("EBADTOKEN");
  });

  it("acquire while locked → ELOCKED", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const a = await service.acquireTicket(t.value, "alice");
    expect(a.ok).toBe(true);
    const b = await service.acquireTicket(t.value, "bob");
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.kind).toBe("ELOCKED");
  });

  it("create_ticket emits a `created` event capturing the resolved initial state", async () => {
    const t = await service.createTicket("P", {
      type: "task",
      title: "T",
      priority: "P0",
      labels: ["x", "y"],
      scope: "auth",
    });
    if (!t.ok) throw new Error("setup");
    const evs = await service.readEvents(t.value);
    if (!evs.ok) throw new Error("readEvents");
    const created = evs.value.find((e) => e.type === "created");
    expect(created).toBeDefined();
    if (created?.type !== "created") return;
    expect(created.ticket_type).toBe("task");
    expect(created.title).toBe("T");
    expect(created.priority).toBe("P0");
    expect(created.labels).toEqual(["x", "y"]);
    expect(created.scope).toBe("auth");
  });

  it("update_ticket emits a fields_change event for non-status edits", async () => {
    const t = await service.createTicket("P", { type: "task", title: "old" });
    if (!t.ok) throw new Error("setup");
    nowMs += 1000;
    const r = await service.updateTicket(t.value, {
      title: "new",
      priority: "P0",
      labels: ["a", "b"],
    });
    expect(r.ok).toBe(true);
    const evs = await service.readEvents(t.value);
    if (!evs.ok) throw new Error("readEvents");
    const fc = evs.value.find((e) => e.type === "fields_change");
    expect(fc).toBeDefined();
    if (fc?.type !== "fields_change") return;
    expect(fc.changes.title).toEqual({ from: "old", to: "new" });
    expect(fc.changes.priority).toEqual({ from: "P2", to: "P0" });
    expect(fc.changes.labels).toEqual({ from: [], to: ["a", "b"] });
  });

  it("update_ticket with only status changes emits status_change but no fields_change", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    nowMs += 1000;
    await service.updateTicket(t.value, { status: "Todo" });
    const evs = await service.readEvents(t.value);
    if (!evs.ok) throw new Error("readEvents");
    const types = evs.value.map((e) => e.type);
    expect(types).toContain("status_change");
    expect(types).not.toContain("fields_change");
  });

  it("acquire_ticket includes system_addendum naming the executor skills", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const a = await service.acquireTicket(t.value, "alice");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // Default skill set is intentionally narrow — protocol skill only.
    expect(a.value.system_addendum).toBe("Use skill team-tracking-execute in your work.");
  });

  it("system_addendum is configurable via ServiceOptions.executorSkills (multi-skill, names only)", async () => {
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    const custom = new TicketService(adapter, new RefMutex(), {
      ttlSeconds: 1800,
      now: () => new Date(nowMs).toISOString(),
      mintToken: () => `tok_${++tokenN}`,
      mintMessageId: () => `msg_${++tokenN}`,
      mintEventId: () => `evt_${++tokenN}`,
      executorSkills: [{ name: "team-tracking-execute" }, { name: "clean-code" }],
    });
    const t = await custom.createTicket("P2", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const a = await custom.acquireTicket(t.value, "alice");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.system_addendum).toBe(
      "Use skill team-tracking-execute and clean-code in your work.",
    );
  });

  it("system_addendum inlines skill body under a `--- name ---` divider", async () => {
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    const inlined = new TicketService(adapter, new RefMutex(), {
      ttlSeconds: 1800,
      now: () => new Date(nowMs).toISOString(),
      mintToken: () => `tok_${++tokenN}`,
      mintMessageId: () => `msg_${++tokenN}`,
      mintEventId: () => `evt_${++tokenN}`,
      executorSkills: [
        {
          name: "team-tracking-execute",
          body: "## Acquire\n\nacquire_ticket(ref, owner) → ...\n",
        },
      ],
    });
    const t = await inlined.createTicket("P4", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const a = await inlined.acquireTicket(t.value, "alice");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.system_addendum).toBe(
      "Use skill team-tracking-execute in your work.\n\n--- team-tracking-execute ---\n## Acquire\n\nacquire_ticket(ref, owner) → ...",
    );
  });

  it("system_addendum is empty when executorSkills is configured to []", async () => {
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
    const bare = new TicketService(adapter, new RefMutex(), {
      ttlSeconds: 1800,
      now: () => new Date(nowMs).toISOString(),
      mintToken: () => `tok_${++tokenN}`,
      mintMessageId: () => `msg_${++tokenN}`,
      mintEventId: () => `evt_${++tokenN}`,
      executorSkills: [],
    });
    const t = await bare.createTicket("P3", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const a = await bare.acquireTicket(t.value, "alice");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.value.system_addendum).toBe("");
  });

  it("stale lock TTL → second acquire succeeds with recovered_checkpoint", async () => {
    const t = await service.createTicket("P", { type: "task", title: "T" });
    if (!t.ok) throw new Error("setup");
    const a = await service.acquireTicket(t.value, "alice");
    if (!a.ok) throw new Error("setup");
    await service.commitCheckpoint(t.value, {
      lock_token: a.value.lock_token,
      commit_id: "deadbeef",
      update: "wip",
      progress_summary: "halfway",
    });

    // Advance well past TTL.
    nowMs += 2 * 1800 * 1000;

    const b = await service.acquireTicket(t.value, "bob");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.value.recovered_checkpoint?.commit_id).toBe("deadbeef");
    expect(b.value.recovered_checkpoint?.update).toBe("wip");
  });
});
