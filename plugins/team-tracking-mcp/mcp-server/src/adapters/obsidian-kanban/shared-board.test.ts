import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "./index.js";

/**
 * Shared-board mode: multiple projects in one vault contribute cards to a
 * single board.md. Per-project ticket folders are unchanged; only the board
 * file location is shared.
 */
describe("obsidian-kanban: shared board across projects", () => {
  let dir: string;
  let adapter: ObsidianKanbanAdapter;
  const projA = "Autopilot";
  const projB = "apollo-design-system";
  const sharedPath = "shared/board.md";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-shared-"));
    adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({
      vaultPath: dir,
      sharedBoard: { path: sharedPath },
      projects: [{ name: projA }, { name: projB }],
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function readShared(): Promise<string> {
    return fs.readFile(path.join(dir, sharedPath), "utf8");
  }

  async function pathExists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  it("places cards from two projects on the same shared board", async () => {
    const a = await adapter.createTicket(projA, { type: "task", title: "wire loader" });
    const b = await adapter.createTicket(projB, { type: "task", title: "host token" });

    const text = await readShared();
    expect(text).toMatch(/\[\[projects\/Autopilot\/.*wire-loader\/ticket/);
    expect(text).toMatch(/\[\[projects\/apollo-design-system\/.*host-token\/ticket/);
    // Card text carries the project tag so the kanban-plugin's filter UI
    // can isolate per-repo views without us shipping a custom plugin.
    expect(text).toMatch(/#Autopilot\b/);
    expect(text).toMatch(/#apollo-design-system\b/);
    expect(a.project).toBe(projA);
    expect(b.project).toBe(projB);
  });

  it("does NOT create per-project board.md when sharing is on", async () => {
    await adapter.createTicket(projA, { type: "task", title: "x" });
    await adapter.createTicket(projB, { type: "task", title: "y" });

    const perProjectA = await pathExists(path.join(dir, "projects", projA, "board.md"));
    const perProjectB = await pathExists(path.join(dir, "projects", projB, "board.md"));
    expect(perProjectA).toBe(false);
    expect(perProjectB).toBe(false);

    const sharedExists = await pathExists(path.join(dir, sharedPath));
    expect(sharedExists).toBe(true);
  });

  it("listBoard(project) returns ONLY that project's cards from the shared file", async () => {
    await adapter.createTicket(projA, { type: "task", title: "wire loader" });
    await adapter.createTicket(projB, { type: "task", title: "host token" });

    const listA = await adapter.listBoard(projA);
    const listB = await adapter.listBoard(projB);
    expect(listA.map((s) => s.ref.project)).toEqual([projA]);
    expect(listB.map((s) => s.ref.project)).toEqual([projB]);
  });

  it("updating a ticket in project A does not affect project B's cards", async () => {
    const a = await adapter.createTicket(projA, { type: "task", title: "A1" });
    const b = await adapter.createTicket(projB, { type: "task", title: "B1" });

    await adapter.updateTicket(a, { status: "Todo" });

    const text = await readShared();
    // Both cards still present, B's card unchanged.
    expect(text).toContain(`projects/${projA}/${a.id}/ticket`);
    expect(text).toContain(`projects/${projB}/${b.id}/ticket`);

    const listB = await adapter.listBoard(projB);
    expect(listB).toHaveLength(1);
    expect(listB[0]?.status).toBe("Backlog");
  });

  it("auto-flip on all-children-Done stays scoped to the parent's project", async () => {
    const epicA = await adapter.createTicket(projA, { type: "epic", title: "epic-A" });
    const taskA = await adapter.createTicket(projA, { type: "task", parent: epicA, title: "tA" });
    const epicB = await adapter.createTicket(projB, { type: "epic", title: "epic-B" });
    const taskB = await adapter.createTicket(projB, { type: "task", parent: epicB, title: "tB" });
    await adapter.updateTicket(epicA, { status: "Todo" });
    await adapter.updateTicket(epicB, { status: "Todo" });

    // Finish only A's task. Auto-flip should fire on epicA, NOT epicB.
    await adapter.updateTicket(taskA, { status: "Done" });

    const a = await adapter.getTicket(epicA);
    const b = await adapter.getTicket(epicB);
    expect(a?.status).toBe("Done");
    expect(b?.status).toBe("Todo");
    // taskB untouched.
    const tB = await adapter.getTicket(taskB);
    expect(tB?.status).toBe("Backlog");
  });
});

describe("obsidian-kanban: shared-board per-project override (useSharedBoard: false)", () => {
  let dir: string;
  const projShared = "Shared";
  const projSolo = "Solo";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-shared-override-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("project with useSharedBoard:false gets its own per-project board", async () => {
    const adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({
      vaultPath: dir,
      sharedBoard: { path: "shared/board.md" },
      projects: [{ name: projShared }, { name: projSolo, useSharedBoard: false }],
    });

    await adapter.createTicket(projShared, { type: "task", title: "shared work" });
    await adapter.createTicket(projSolo, { type: "task", title: "solo work" });

    const sharedText = await fs.readFile(path.join(dir, "shared", "board.md"), "utf8");
    const soloText = await fs.readFile(path.join(dir, "projects", projSolo, "board.md"), "utf8");

    expect(sharedText).toContain(`projects/${projShared}/`);
    expect(sharedText).not.toContain(`projects/${projSolo}/`);
    expect(soloText).toContain(`projects/${projSolo}/`);
  });
});

describe("obsidian-kanban: rebuildSharedBoard", () => {
  let dir: string;
  const projA = "Autopilot";
  const projB = "apollo-design-system";
  const sharedPath = "shared/board.md";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-rebuild-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function makeAdapter(): Promise<ObsidianKanbanAdapter> {
    const a = new ObsidianKanbanAdapter(dir);
    await a.init({
      vaultPath: dir,
      sharedBoard: { path: sharedPath },
      projects: [{ name: projA }, { name: projB }],
    });
    return a;
  }

  it("recreates a deleted shared board from ticket files", async () => {
    const a = await makeAdapter();
    await a.createTicket(projA, { type: "task", title: "T1" });
    await a.createTicket(projB, { type: "task", title: "T2" });

    await fs.unlink(path.join(dir, sharedPath));
    await a.rebuildSharedBoard();

    const text = await fs.readFile(path.join(dir, sharedPath), "utf8");
    expect(text).toContain(`projects/${projA}/`);
    expect(text).toContain(`projects/${projB}/`);
  });

  it("recovers a corrupted shared board to clean state", async () => {
    const a = await makeAdapter();
    await a.createTicket(projA, { type: "task", title: "T1" });

    await fs.writeFile(path.join(dir, sharedPath), "GARBAGE\nthis is not a kanban file\n");
    await a.rebuildSharedBoard();

    const text = await fs.readFile(path.join(dir, sharedPath), "utf8");
    expect(text).toContain("kanban-plugin: board");
    expect(text).toContain(`projects/${projA}/`);
    expect(text).not.toContain("GARBAGE");
  });

  it("is idempotent — rebuilding twice produces identical content", async () => {
    const a = await makeAdapter();
    await a.createTicket(projA, { type: "task", title: "T1" });
    await a.createTicket(projB, { type: "task", title: "T2" });

    await a.rebuildSharedBoard();
    const first = await fs.readFile(path.join(dir, sharedPath), "utf8");
    await a.rebuildSharedBoard();
    const second = await fs.readFile(path.join(dir, sharedPath), "utf8");
    expect(second).toBe(first);
  });
});
