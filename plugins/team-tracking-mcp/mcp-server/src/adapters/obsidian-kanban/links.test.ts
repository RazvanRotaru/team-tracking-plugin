import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObsidianKanbanAdapter } from "./index.js";

/**
 * For every wiki-link that the adapter emits (board cards, sub-bullets,
 * and the parent's `## Children` checklist), the link target must point
 * at an actual file that exists in the vault. We collect every
 * `[[link|display]]` occurrence under the project folder and verify the
 * target file exists at `<vault>/<linkTarget>.md`.
 */
describe("wiki-link integrity", () => {
  let dir: string;
  let adapter: ObsidianKanbanAdapter;
  const project = "P";

  const linkRe = /\[\[([^|\]]+)\|[^\]]+\]\]/g;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ttmcp-links-"));
    adapter = new ObsidianKanbanAdapter(dir);
    await adapter.init({ vaultPath: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function gatherEmittedLinks(): Promise<Set<string>> {
    const links = new Set<string>();
    const walk = async (p: string): Promise<void> => {
      const entries = await fs.readdir(p, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(p, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.name.endsWith(".md")) {
          const text = await fs.readFile(full, "utf8");
          for (const m of text.matchAll(linkRe)) {
            const target = (m[1] ?? "").trim();
            if (target.length > 0) links.add(target);
          }
        }
      }
    };
    await walk(path.join(dir, "projects", project));
    return links;
  }

  it("every emitted wiki-link target resolves to an existing file", async () => {
    // Build a tree that exercises all four types and the propagation paths
    // (epic with story-with-task-with-subtask, top-level task with subtask,
    // and a Done child to flip checkbox state).
    const epic = await adapter.createTicket(project, { type: "epic", title: "E" });
    const story = await adapter.createTicket(project, {
      type: "story",
      parent: epic,
      title: "S",
    });
    const task = await adapter.createTicket(project, {
      type: "task",
      parent: story,
      title: "T",
    });
    await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "Sub-A",
    });
    const subB = await adapter.createTicket(project, {
      type: "subtask",
      parent: task,
      title: "Sub-B",
    });
    await adapter.updateTicket(subB, { status: "Done" });

    const standaloneTask = await adapter.createTicket(project, {
      type: "task",
      title: "Standalone",
    });
    await adapter.createTicket(project, {
      type: "subtask",
      parent: standaloneTask,
      title: "Helper",
    });

    const links = await gatherEmittedLinks();
    expect(links.size).toBeGreaterThan(0);

    for (const target of links) {
      const file = path.join(dir, `${target}.md`);
      const exists = await fs
        .stat(file)
        .then(() => true)
        .catch(() => false);
      expect(exists, `wiki-link "${target}" → ${file} should exist`).toBe(true);
    }
  });

  it("links use vault-relative paths anchored at projects/<project>/", async () => {
    const epic = await adapter.createTicket(project, { type: "epic", title: "Onboard" });
    await adapter.createTicket(project, { type: "story", parent: epic, title: "S1" });

    const board = await fs.readFile(path.join(dir, "projects", project, "board.md"), "utf8");
    const epicTicket = await fs.readFile(
      path.join(dir, "projects", project, "tickets", "onboard", "ticket.md"),
      "utf8",
    );

    for (const text of [board, epicTicket]) {
      for (const m of text.matchAll(linkRe)) {
        expect(m[1] ?? "").toMatch(/^projects\/P\//);
      }
    }
  });
});
