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
