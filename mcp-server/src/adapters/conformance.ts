import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Lock, TicketRef } from "../domain/types.js";
import type { TrackerAdapter } from "./types.js";

export type ConformanceFixture = {
  adapter: TrackerAdapter;
  project: string;
  cleanup?: () => Promise<void>;
};

/**
 * Black-box conformance test suite. Every adapter must pass.
 *
 * Call from a `*.test.ts` file with a factory that produces a fresh adapter
 * (and project namespace) per test.
 */
export function runConformance(name: string, makeFixture: () => Promise<ConformanceFixture>): void {
  describe(`adapter conformance: ${name}`, () => {
    let fx: ConformanceFixture;

    beforeEach(async () => {
      fx = await makeFixture();
    });

    afterEach(async () => {
      if (fx?.cleanup) await fx.cleanup();
    });

    // ── Create / read ──────────────────────────────────────────────────

    it("creates and reads back an epic", async () => {
      const ref = await fx.adapter.createTicket(fx.project, {
        type: "epic",
        title: "Build a thing",
      });
      const t = await fx.adapter.getTicket(ref);
      expect(t).not.toBeNull();
      if (!t) return;
      expect(t.type).toBe("epic");
      expect(t.title).toBe("Build a thing");
      expect(t.parent).toBeNull();
      expect(t.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(t.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("creates story under epic with parent ref resolved on read", async () => {
      const epic = await fx.adapter.createTicket(fx.project, {
        type: "epic",
        title: "Auth",
      });
      const story = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "Login flow",
      });
      const got = await fx.adapter.getTicket(story);
      expect(got?.type).toBe("story");
      expect(got?.parent).toEqual(epic);
    });

    it("creates task under story", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      const story = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S",
      });
      const task = await fx.adapter.createTicket(fx.project, {
        type: "task",
        parent: story,
        title: "T",
      });
      const got = await fx.adapter.getTicket(task);
      expect(got?.parent).toEqual(story);
    });

    it("creates task directly under epic (skip story)", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      const task = await fx.adapter.createTicket(fx.project, {
        type: "task",
        parent: epic,
        title: "T",
      });
      const got = await fx.adapter.getTicket(task);
      expect(got?.parent).toEqual(epic);
    });

    it("creates subtask under task", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      const story = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S",
      });
      const task = await fx.adapter.createTicket(fx.project, {
        type: "task",
        parent: story,
        title: "T",
      });
      const sub = await fx.adapter.createTicket(fx.project, {
        type: "subtask",
        parent: task,
        title: "Sub",
      });
      const got = await fx.adapter.getTicket(sub);
      expect(got?.type).toBe("subtask");
      expect(got?.parent).toEqual(task);
    });

    it("creates subtask directly under story", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      const story = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S",
      });
      const sub = await fx.adapter.createTicket(fx.project, {
        type: "subtask",
        parent: story,
        title: "Sub",
      });
      expect((await fx.adapter.getTicket(sub))?.parent).toEqual(story);
    });

    it("getTicket returns null for unknown refs", async () => {
      const got = await fx.adapter.getTicket({ project: fx.project, id: "does-not-exist" });
      expect(got).toBeNull();
    });

    it("default fields populated on creation", async () => {
      const ref = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "X",
      });
      const t = await fx.adapter.getTicket(ref);
      expect(t).not.toBeNull();
      if (!t) return;
      expect(["Backlog", "Todo"]).toContain(t.status); // adapters may default to either
      expect(t.priority).toBe("P2");
      expect(t.labels).toEqual([]);
      expect(t.scope).toBeNull();
      expect(t.branch).toBeNull();
      expect(t.pr_url).toBeNull();
      expect(t.update).toBeNull();
      expect(t.progress_summary).toBeNull();
      expect(t.lock).toBeNull();
      expect(t.lock_state).toBe("free");
    });

    it("create accepts body, priority, labels, scope", async () => {
      const ref = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "X",
        body: "the description",
        priority: "P0",
        labels: ["a", "b"],
        scope: "auth",
      });
      const t = await fx.adapter.getTicket(ref);
      expect(t?.body).toContain("the description");
      expect(t?.priority).toBe("P0");
      expect(t?.labels).toEqual(["a", "b"]);
      expect(t?.scope).toBe("auth");
    });

    // ── Update ──────────────────────────────────────────────────────────

    it("updateTicket changes title", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "old" });
      await fx.adapter.updateTicket(ref, { title: "new" });
      expect((await fx.adapter.getTicket(ref))?.title).toBe("new");
    });

    it("updateTicket changes status", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.updateTicket(ref, { status: "In Progress" });
      expect((await fx.adapter.getTicket(ref))?.status).toBe("In Progress");
    });

    it("updateTicket changes priority", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.updateTicket(ref, { priority: "P0" });
      expect((await fx.adapter.getTicket(ref))?.priority).toBe("P0");
    });

    it("updateTicket replaces labels (does not merge)", async () => {
      const ref = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "X",
        labels: ["a", "b"],
      });
      await fx.adapter.updateTicket(ref, { labels: ["c"] });
      expect((await fx.adapter.getTicket(ref))?.labels).toEqual(["c"]);
    });

    it("updateTicket sets scope, branch, pr_url", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.updateTicket(ref, {
        scope: "module-x",
        branch: "feat/x",
        pr_url: "https://gh/pr/1",
      });
      const t = await fx.adapter.getTicket(ref);
      expect(t?.scope).toBe("module-x");
      expect(t?.branch).toBe("feat/x");
      expect(t?.pr_url).toBe("https://gh/pr/1");
    });

    it("updateTicket roundtrips body markdown", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      const body = "## Subhead\n\nA paragraph with **bold**.\n\n- item\n";
      await fx.adapter.updateTicket(ref, { body });
      const got = await fx.adapter.getTicket(ref);
      expect(got?.body).toContain("Subhead");
      expect(got?.body).toContain("**bold**");
    });

    // ── Children ────────────────────────────────────────────────────────

    it("listChildren returns child refs of a parent", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      const s1 = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S1",
      });
      const s2 = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S2",
      });
      const kids = await fx.adapter.listChildren(epic);
      const refs = kids.map((c) => c.ref).sort((a, b) => a.id.localeCompare(b.id));
      const expected = [s1, s2].sort((a, b) => a.id.localeCompare(b.id));
      expect(refs).toEqual(expected);
    });

    it("listChildren returns [] for a leaf", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      expect(await fx.adapter.listChildren(epic)).toEqual([]);
    });

    it("getTicket includes children refs", async () => {
      const epic = await fx.adapter.createTicket(fx.project, { type: "epic", title: "E" });
      const story = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S",
      });
      const got = await fx.adapter.getTicket(epic);
      expect(got?.children).toContainEqual(story);
    });

    // ── listBoard ───────────────────────────────────────────────────────

    it("listBoard returns top-level tickets only", async () => {
      const epic = await fx.adapter.createTicket(fx.project, {
        type: "epic",
        title: "E",
      });
      await fx.adapter.updateTicket(epic, { status: "In Progress" });
      const story = await fx.adapter.createTicket(fx.project, {
        type: "story",
        parent: epic,
        title: "S",
      });
      await fx.adapter.updateTicket(story, { status: "In Progress" });
      const board = await fx.adapter.listBoard(fx.project);
      const ids = board.map((s) => s.ref.id);
      expect(ids).toContain(epic.id);
      expect(ids).not.toContain(story.id);
    });

    it("listBoard orders by status: In Progress > Todo > Backlog", async () => {
      const t1 = await fx.adapter.createTicket(fx.project, { type: "task", title: "T1" });
      const t2 = await fx.adapter.createTicket(fx.project, { type: "task", title: "T2" });
      const t3 = await fx.adapter.createTicket(fx.project, { type: "task", title: "T3" });
      await fx.adapter.updateTicket(t1, { status: "Backlog" });
      await fx.adapter.updateTicket(t2, { status: "In Progress" });
      await fx.adapter.updateTicket(t3, { status: "Todo" });
      const board = await fx.adapter.listBoard(fx.project);
      const ordered = board.map((s) => s.ref.id);
      expect(ordered.indexOf(t2.id)).toBeLessThan(ordered.indexOf(t3.id));
      expect(ordered.indexOf(t3.id)).toBeLessThan(ordered.indexOf(t1.id));
    });

    it("listBoard excludes In Review and Done by default", async () => {
      const t1 = await fx.adapter.createTicket(fx.project, { type: "task", title: "T1" });
      const t2 = await fx.adapter.createTicket(fx.project, { type: "task", title: "T2" });
      const t3 = await fx.adapter.createTicket(fx.project, { type: "task", title: "T3" });
      await fx.adapter.updateTicket(t1, { status: "In Review" });
      await fx.adapter.updateTicket(t2, { status: "Done" });
      await fx.adapter.updateTicket(t3, { status: "Todo" });
      const board = await fx.adapter.listBoard(fx.project);
      const ids = board.map((s) => s.ref.id);
      expect(ids).toContain(t3.id);
      expect(ids).not.toContain(t1.id);
      expect(ids).not.toContain(t2.id);
    });

    it("listBoard ties broken by priority (P0 before P1 before P2)", async () => {
      const a = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "A",
        priority: "P2",
      });
      const b = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "B",
        priority: "P0",
      });
      const c = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "C",
        priority: "P1",
      });
      for (const r of [a, b, c]) await fx.adapter.updateTicket(r, { status: "In Progress" });
      const board = await fx.adapter.listBoard(fx.project);
      const ids = board.map((s) => s.ref.id);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(c.id));
      expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(a.id));
    });

    it("listBoard summary includes update field", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.updateTicket(ref, { status: "Todo" });
      await fx.adapter.writeProgress(ref, { update: "halfway", progress_summary: null });
      const board = await fx.adapter.listBoard(fx.project);
      const found = board.find((s) => s.ref.id === ref.id);
      expect(found?.update).toBe("halfway");
    });

    // ── Lock ────────────────────────────────────────────────────────────

    it("writeLock null leaves lock free", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.writeLock(ref, null);
      const t = await fx.adapter.getTicket(ref);
      expect(t?.lock).toBeNull();
      expect(t?.lock_state).toBe("free");
    });

    it("writeLock persists owner, token, acquired_at; lock_state derives to in_progress", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      const lock: Lock = {
        owner: "alice@sub-1",
        token: "tok_abc",
        acquired_at: "2026-04-24T10:00:00Z",
        last_checkpoint: null,
      };
      await fx.adapter.writeLock(ref, lock);
      const t = await fx.adapter.getTicket(ref);
      expect(t?.lock).toEqual(lock);
      expect(t?.lock_state).toBe("in_progress");
    });

    it("writeLock with checkpoint persists last_checkpoint exactly; derives committed", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      const lock: Lock = {
        owner: "alice",
        token: "tok",
        acquired_at: "2026-04-24T10:00:00Z",
        last_checkpoint: {
          commit_id: "abc1234",
          update: "u",
          progress_summary: "ps",
          at: "2026-04-24T10:05:00Z",
        },
      };
      await fx.adapter.writeLock(ref, lock);
      const t = await fx.adapter.getTicket(ref);
      expect(t?.lock).toEqual(lock);
      expect(t?.lock_state).toBe("committed");
    });

    it("writeLock then writeLock(null) clears the lock", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.writeLock(ref, {
        owner: "a",
        token: "t",
        acquired_at: "2026-04-24T10:00:00Z",
        last_checkpoint: null,
      });
      await fx.adapter.writeLock(ref, null);
      const t = await fx.adapter.getTicket(ref);
      expect(t?.lock).toBeNull();
      expect(t?.lock_state).toBe("free");
    });

    // ── Progress ────────────────────────────────────────────────────────

    it("writeProgress sets update and progress_summary", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.writeProgress(ref, { update: "u1", progress_summary: "ps1" });
      const t = await fx.adapter.getTicket(ref);
      expect(t?.update).toBe("u1");
      expect(t?.progress_summary).toBe("ps1");
    });

    it("writeProgress overwrites previous values", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.writeProgress(ref, { update: "u1", progress_summary: "ps1" });
      await fx.adapter.writeProgress(ref, { update: "u2", progress_summary: "ps2" });
      const t = await fx.adapter.getTicket(ref);
      expect(t?.update).toBe("u2");
      expect(t?.progress_summary).toBe("ps2");
    });

    it("writeProgress with null clears the field", async () => {
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await fx.adapter.writeProgress(ref, { update: "u1", progress_summary: "ps1" });
      await fx.adapter.writeProgress(ref, { update: null, progress_summary: null });
      const t = await fx.adapter.getTicket(ref);
      expect(t?.update).toBeNull();
      expect(t?.progress_summary).toBeNull();
    });

    // ── Log ─────────────────────────────────────────────────────────────

    it("appendLog tolerates multiple calls without error", async () => {
      // The TicketDTO does not expose log content (the audit trail lives in
      // adapter-native form: ticket.md `## Log` for Obsidian, issue comments
      // for Jira). Conformance only verifies the API surface accepts repeated
      // log writes idempotently.
      const ref = await fx.adapter.createTicket(fx.project, { type: "task", title: "X" });
      await expect(fx.adapter.appendLog(ref, "first event")).resolves.toBeUndefined();
      await expect(fx.adapter.appendLog(ref, "second event")).resolves.toBeUndefined();
      // Ticket should still load cleanly afterwards.
      expect(await fx.adapter.getTicket(ref)).not.toBeNull();
    });

    // ── Ref identity ───────────────────────────────────────────────────

    it("refs returned from createTicket roundtrip through getTicket", async () => {
      const ref: TicketRef = await fx.adapter.createTicket(fx.project, {
        type: "task",
        title: "X",
      });
      expect(ref.project).toBeTruthy();
      expect(ref.id).toBeTruthy();
      const t = await fx.adapter.getTicket(ref);
      expect(t?.ref).toEqual(ref);
    });
  });
}
