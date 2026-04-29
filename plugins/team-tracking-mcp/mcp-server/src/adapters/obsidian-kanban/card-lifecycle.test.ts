import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "./index.js";

/**
 * Card-lifecycle rules under the obsidian-kanban adapter.
 *
 * Definitions:
 *  - "leaf"     = ticket of type `subtask`. Never gets its own kanban card;
 *                 only appears as a checklist sub-bullet on its parent's card.
 *  - "non-leaf" = ticket of type `epic`/`story`/`task`. Eligible for its own
 *                 kanban card.
 *
 * Placement rule: a non-leaf gets its own card on the board iff
 *   1. it's top-level (`parent === null`), OR
 *   2. its parent's status has ever advanced past Backlog (i.e. the parent
 *      has been "committed to plan").
 *
 * Trigger: when a parent transitions Backlog → (anything else), all of its
 * existing non-leaf children are placed on the board. Children created later
 * under a non-Backlog parent are placed immediately on creation.
 *
 * Auto-flip: when every child of a non-leaf reaches Done, the parent's status
 * flips to Done automatically. The flip propagates up: if the parent's flip
 * causes all of its siblings to become Done, the grandparent flips, etc.
 */
describe("card lifecycle: hoisting non-leaf children", () => {
  let dir: string;
  let adapter: ObsidianKanbanAdapter;
  const project = "P";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-lifecycle-"));
    adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function readBoard(): Promise<string> {
    return fs.readFile(path.join(dir, "projects", project, "board.md"), "utf8");
  }

  /** Return board cards (top-level lines) parsed as `{column, id}` pairs. */
  async function boardCards(): Promise<Array<{ column: string; id: string }>> {
    const text = await readBoard();
    const lines = text.split("\n");
    const out: Array<{ column: string; id: string }> = [];
    let column = "";
    for (const line of lines) {
      const h = line.match(/^## (.+?)\s*$/);
      if (h) {
        column = h[1] ?? "";
        continue;
      }
      const c = line.match(/^- \[[ x]\] \[\[([^|\]]+)\|/);
      if (c) {
        const id = (c[1] ?? "").replace(/\/ticket$/, "");
        out.push({ column, id });
      }
    }
    return out;
  }

  it("non-leaf child does NOT get a card while its parent is in Backlog", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    await adapter.createTicket(project, { type: "task", parent: epic, title: "T1" });

    const cards = await boardCards();
    expect(cards.map((c) => c.id)).toEqual([`projects/${project}/${epic.id}`]);
    expect(cards[0]?.column).toBe("Backlog");
  });

  it("hoists existing non-leaf children when parent transitions Backlog → Todo", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const t1 = await adapter.createTicket(project, { type: "task", parent: epic, title: "T1" });
    const t2 = await adapter.createTicket(project, { type: "task", parent: epic, title: "T2" });

    await adapter.updateTicket(epic, { status: "Todo" });

    const cards = await boardCards();
    const ids = new Set(cards.map((c) => c.id));
    expect(ids.has(`projects/${project}/${epic.id}`)).toBe(true);
    expect(ids.has(`projects/${project}/${t1.id}`)).toBe(true);
    expect(ids.has(`projects/${project}/${t2.id}`)).toBe(true);

    // Each task's own card lands in Backlog (its own status is still Backlog
    // even though the parent moved to Todo). The epic's card is in Todo.
    const byId = new Map(cards.map((c) => [c.id, c.column] as const));
    expect(byId.get(`projects/${project}/${epic.id}`)).toBe("Todo");
    expect(byId.get(`projects/${project}/${t1.id}`)).toBe("Backlog");
    expect(byId.get(`projects/${project}/${t2.id}`)).toBe("Backlog");
  });

  it("subtasks (leaves) NEVER get their own card on the board", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const task = await adapter.createTicket(project, {
      type: "task",
      parent: epic,
      title: "T",
    });
    const subA = await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "S-A",
    });

    await adapter.updateTicket(epic, { status: "Todo" });
    await adapter.updateTicket(task, { status: "Todo" });

    const cards = await boardCards();
    const ids = new Set(cards.map((c) => c.id));
    expect(ids.has(`projects/${project}/${subA.id}`)).toBe(false);
  });

  it("non-leaf created under a non-Backlog parent is placed on the board immediately", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    await adapter.updateTicket(epic, { status: "Todo" });

    const t1 = await adapter.createTicket(project, { type: "task", parent: epic, title: "T1" });

    const cards = await boardCards();
    expect(cards.map((c) => c.id)).toContain(`projects/${project}/${t1.id}`);
  });

  it("a hoisted card moves between columns when its own status changes", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const t1 = await adapter.createTicket(project, { type: "task", parent: epic, title: "T1" });
    await adapter.updateTicket(epic, { status: "Todo" });

    await adapter.updateTicket(t1, { status: "Todo" });
    let cards = await boardCards();
    let byId = new Map(cards.map((c) => [c.id, c.column] as const));
    expect(byId.get(`projects/${project}/${t1.id}`)).toBe("Todo");

    await adapter.updateTicket(t1, { status: "In Progress" });
    cards = await boardCards();
    byId = new Map(cards.map((c) => [c.id, c.column] as const));
    expect(byId.get(`projects/${project}/${t1.id}`)).toBe("In Progress");
  });

  it("non-leaf's own card surfaces ITS immediate children as sub-bullets", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const task = await adapter.createTicket(project, {
      type: "task",
      parent: epic,
      title: "T",
    });
    const sub = await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "S",
    });
    await adapter.updateTicket(epic, { status: "Todo" });

    const text = await readBoard();
    const taskHead = `[[projects/${project}/${task.id}/ticket|`;
    const subBullet = `[[projects/${project}/${sub.id}/ticket|`;
    const head = text.indexOf(taskHead);
    expect(head, "task card head must exist").toBeGreaterThan(-1);
    const tail = text.slice(head);
    const nextHead = tail.slice(taskHead.length).search(/^- \[[ x]\] \[\[/m);
    const taskBlock = nextHead > -1 ? tail.slice(0, taskHead.length + nextHead) : tail;
    expect(taskBlock).toContain(subBullet);
  });
});

describe("card lifecycle: auto-flip parent on all-children-Done", () => {
  let dir: string;
  let adapter: ObsidianKanbanAdapter;
  const project = "P";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-autoflip-"));
    adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("flips a task to Done when its only subtask becomes Done", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const task = await adapter.createTicket(project, {
      type: "task",
      parent: epic,
      title: "T",
    });
    const sub = await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "S",
    });

    await adapter.updateTicket(sub, { status: "Done" });

    const taskAfter = await adapter.getTicket(task);
    expect(taskAfter?.status).toBe("Done");
  });

  it("does NOT flip a task to Done while at least one subtask is not Done", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const task = await adapter.createTicket(project, {
      type: "task",
      parent: epic,
      title: "T",
    });
    const subA = await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "S-A",
    });
    await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "S-B",
    });

    await adapter.updateTicket(subA, { status: "Done" });

    const taskAfter = await adapter.getTicket(task);
    expect(taskAfter?.status).not.toBe("Done");
  });

  it("propagates the flip up the chain (epic → task → subtask)", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const task = await adapter.createTicket(project, {
      type: "task",
      parent: epic,
      title: "T",
    });
    const sub = await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "S",
    });

    await adapter.updateTicket(sub, { status: "Done" });

    const epicAfter = await adapter.getTicket(epic);
    expect(epicAfter?.status).toBe("Done");
  });

  it("does NOT auto-flip a parent that has zero children", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "Empty" });

    // No state mutation that should trigger an auto-flip — guard against a
    // bug where "zero children all-Done" trivially evaluates true.
    await adapter.updateTicket(epic, { status: "Todo" });

    const epicAfter = await adapter.getTicket(epic);
    expect(epicAfter?.status).toBe("Todo");
  });
});
