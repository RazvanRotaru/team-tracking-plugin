import * as fs from "node:fs";
import * as path from "node:path";
import { deriveLockState } from "../../domain/lock.js";
import type {
  CreateTicketDTO,
  Event,
  Lock,
  Message,
  TicketDTO,
  TicketRef,
  TicketSummaryDTO,
  UpdateDTO,
} from "../../domain/types.js";
import type {
  AdapterConfig,
  TrackerAdapter,
  WatcherCallback,
  WatcherUnsubscribe,
} from "../types.js";
import {
  BOARD_COLUMNS,
  type CardChild,
  formatCard,
  initialBoardText,
  listBoardCards,
  upsertCard,
} from "./board-edit.js";
import {
  type ParsedTicketFile,
  type TicketFrontmatter,
  parseTicketFile,
  renderTicketFile,
} from "./frontmatter.js";
import { slugify, uniqueSlug } from "./slug.js";
import {
  ensureDir,
  listSubdirs,
  pathExists,
  readFileIfExists,
  writeFileAtomic,
} from "./vault-io.js";

const BOARD_STATUS_PRIORITY: Record<string, number> = {
  "In Progress": 0,
  Todo: 1,
  Backlog: 2,
};
const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

export type ObsidianKanbanConfig = {
  vaultPath: string;
};

export class ObsidianKanbanAdapter implements TrackerAdapter {
  private vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async init(config: AdapterConfig): Promise<void> {
    if (typeof config.vaultPath === "string") {
      this.vaultPath = config.vaultPath;
    }
    await ensureDir(this.vaultPath);
  }

  // ── path helpers ────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return path.join(this.vaultPath, "projects", project);
  }

  private ticketDir(ref: TicketRef): string {
    return path.join(this.projectDir(ref.project), ref.id);
  }

  private ticketFile(ref: TicketRef): string {
    return path.join(this.ticketDir(ref), "ticket.md");
  }

  private boardFile(project: string): string {
    return path.join(this.projectDir(project), "board.md");
  }

  /**
   * Vault-relative path prefix for a ticket (no `/ticket` suffix). This is
   * the canonical, globally-unique key we put in wiki-links. Pinning links
   * to the absolute path avoids Obsidian's suffix-match resolution picking
   * the wrong `ticket.md` in vaults with multiple projects or sibling
   * children that share a slug.
   */
  private linkPrefix(ref: TicketRef): string {
    return `projects/${ref.project}/${ref.id}`;
  }

  /** `${linkPrefix(ref)}/ticket` — the literal target stored in `[[...]]`. */
  private linkTarget(ref: TicketRef): string {
    return `${this.linkPrefix(ref)}/ticket`;
  }

  /** Derive a TicketRef from a card's link prefix. Returns null on mismatch. */
  private refFromLinkPrefix(project: string, prefix: string): TicketRef | null {
    const expected = `projects/${project}/`;
    if (!prefix.startsWith(expected)) return null;
    return { project, id: prefix.slice(expected.length) };
  }

  private parentRefFromIdAndProject(
    project: string,
    parentPathId: string | null,
  ): TicketRef | null {
    return parentPathId ? { project, id: parentPathId } : null;
  }

  // ── project scaffold ─────────────────────────────────────────────────

  private async ensureProject(project: string): Promise<void> {
    const dir = this.projectDir(project);
    await ensureDir(dir);
    await ensureDir(path.join(dir, "tickets"));
    if (!(await pathExists(this.boardFile(project)))) {
      await writeFileAtomic(this.boardFile(project), initialBoardText());
    }
    const arch = path.join(dir, "architecture.md");
    if (!(await pathExists(arch))) {
      await writeFileAtomic(arch, "# Architecture\n\n");
    }
  }

  // ── reading tickets ─────────────────────────────────────────────────

  private async loadParsed(ref: TicketRef): Promise<ParsedTicketFile | null> {
    const text = await readFileIfExists(this.ticketFile(ref));
    if (text === null) return null;
    return parseTicketFile(text);
  }

  private async childRefs(ref: TicketRef): Promise<TicketRef[]> {
    const childrenDir = path.join(this.ticketDir(ref), "children");
    const slugs = await listSubdirs(childrenDir);
    return slugs
      .filter((s) => !s.startsWith("."))
      .map((s) => ({ project: ref.project, id: `${ref.id}/children/${s}` }));
  }

  /**
   * Collect immediate children of `ref` as the entries fed to
   * `renderTicketFile`'s Children section. Each entry carries a fully
   * qualified vault-relative link target so wiki-links never resolve to
   * the wrong file.
   */
  private async collectChildEntries(
    ref: TicketRef,
  ): Promise<Array<{ linkTarget: string; slug: string; done: boolean }>> {
    const childRefs = await this.childRefs(ref);
    const out: Array<{ linkTarget: string; slug: string; done: boolean }> = [];
    for (const c of childRefs) {
      const p = await this.loadParsed(c);
      if (!p) continue;
      out.push({
        linkTarget: this.linkTarget(c),
        slug: path.basename(c.id),
        done: p.frontmatter.status === "Done",
      });
    }
    return out;
  }

  private toDTO(ref: TicketRef, parsed: ParsedTicketFile, children: TicketRef[]): TicketDTO {
    const fm = parsed.frontmatter;
    const lock = fm.lock ?? null;
    return {
      ref,
      type: fm.type,
      parent: this.parentRefFromIdAndProject(ref.project, fm.parent),
      title: this.deriveTitle(parsed),
      body: parsed.body,
      status: fm.status,
      priority: fm.priority,
      labels: fm.labels ?? [],
      scope: fm.scope ?? null,
      branch: fm.branch ?? null,
      pr_url: fm.pr_url ?? null,
      update: fm.update ?? null,
      progress_summary: fm.progress_summary ?? null,
      lock_state: deriveLockState(lock),
      lock,
      created: fm.created,
      updated: fm.updated,
      children,
    };
  }

  /**
   * Title is rendered as the first `# Heading` line of the body when present,
   * else falls back to the slug. This keeps the title visible in Obsidian
   * without duplicating it in frontmatter.
   */
  private deriveTitle(parsed: ParsedTicketFile): string {
    const m = parsed.body.match(/^#\s+(.+?)\s*$/m);
    if (m) return m[1] ?? "";
    return "";
  }

  async getTicket(ref: TicketRef): Promise<TicketDTO | null> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) return null;
    const children = await this.childRefs(ref);
    return this.toDTO(ref, parsed, children);
  }

  async listChildren(ref: TicketRef): Promise<TicketDTO[]> {
    const childRefs = await this.childRefs(ref);
    const out: TicketDTO[] = [];
    for (const c of childRefs) {
      const t = await this.getTicket(c);
      if (t) out.push(t);
    }
    return out;
  }

  async listBoard(project: string): Promise<TicketSummaryDTO[]> {
    const boardText = await readFileIfExists(this.boardFile(project));
    if (boardText === null) return [];
    const cards = listBoardCards(boardText);

    const summaries: TicketSummaryDTO[] = [];
    for (const card of cards) {
      const ref = this.refFromLinkPrefix(project, card.id);
      if (!ref) continue;
      const parsed = await this.loadParsed(ref);
      if (!parsed) continue;
      const fm = parsed.frontmatter;
      const lock = fm.lock ?? null;
      summaries.push({
        ref,
        type: fm.type,
        title: this.deriveTitle(parsed),
        status: fm.status,
        priority: fm.priority,
        scope: fm.scope ?? null,
        branch: fm.branch ?? null,
        update: fm.update ?? null,
        lock_state: deriveLockState(lock),
      });
    }

    return summaries
      .filter((s) => s.status in BOARD_STATUS_PRIORITY)
      .sort((a, b) => {
        const sa = BOARD_STATUS_PRIORITY[a.status] ?? 99;
        const sb = BOARD_STATUS_PRIORITY[b.status] ?? 99;
        if (sa !== sb) return sa - sb;
        const pa = PRIORITY_ORDER[a.priority] ?? 99;
        const pb = PRIORITY_ORDER[b.priority] ?? 99;
        return pa - pb;
      });
  }

  // ── creating tickets ─────────────────────────────────────────────────

  async createTicket(project: string, draft: CreateTicketDTO): Promise<TicketRef> {
    await this.ensureProject(project);

    const parentRef = draft.parent ?? null;

    // Determine the directory the new ticket folder will go inside.
    let baseDir: string;
    let baseId: string; // path-id prefix for the new ticket
    if (parentRef === null) {
      baseDir = path.join(this.projectDir(project), "tickets");
      baseId = "tickets";
    } else {
      baseDir = path.join(this.ticketDir(parentRef), "children");
      baseId = `${parentRef.id}/children`;
    }
    await ensureDir(baseDir);

    const existing = await listSubdirs(baseDir);
    const slug = uniqueSlug(slugify(draft.title), (s) => existing.includes(s));
    const id = `${baseId}/${slug}`;
    const ref: TicketRef = { project, id };

    const now = new Date().toISOString();
    const defaultStatus = draft.type === "subtask" ? "Todo" : "Backlog";
    const fm: TicketFrontmatter = {
      type: draft.type,
      parent: parentRef ? parentRef.id : null,
      status: defaultStatus,
      priority: draft.priority ?? "P2",
      labels: draft.labels ?? [],
      scope: draft.scope ?? null,
      branch: null,
      pr_url: null,
      update: null,
      progress_summary: null,
      lock: null,
      created: now,
      updated: now,
    };

    const bodyHeader = `# ${draft.title}\n`;
    const bodyText = draft.body ? `${bodyHeader}\n${draft.body.trimEnd()}\n` : bodyHeader;

    const text = renderTicketFile({
      frontmatter: fm,
      body: bodyText,
      children: [], // brand new — no children yet
      log: [],
      events: [],
    });
    await ensureDir(this.ticketDir(ref));
    await writeFileAtomic(this.ticketFile(ref), text);

    if (parentRef === null) {
      // Top-level: add card to board.
      await this.placeBoardCard(ref, fm.status, fm.priority, draft.type, slug);
    } else {
      // Nested: refresh parent's Children section, then refresh the
      // top-level ancestor's board card so its child summary stays current.
      await this.refreshParentChildren(parentRef);
      await this.refreshTopLevelBoardCard(parentRef);
    }

    return ref;
  }

  private async placeBoardCard(
    ref: TicketRef,
    status: string,
    priority: TicketFrontmatter["priority"],
    type: TicketFrontmatter["type"],
    slug: string,
  ): Promise<void> {
    const boardPath = this.boardFile(ref.project);
    const boardText = (await readFileIfExists(boardPath)) ?? initialBoardText();
    if (!BOARD_COLUMNS.includes(status)) return;
    const children = await this.collectImmediateChildSummaries(ref);
    const cardLinkPrefix = this.linkPrefix(ref);
    const cardLine = formatCard({
      id: cardLinkPrefix,
      slug,
      priority,
      type,
      done: status === "Done",
      children,
    });
    const next = upsertCard(boardText, {
      id: cardLinkPrefix,
      column: status,
      cardLine,
    });
    await writeFileAtomic(boardPath, next);
  }

  private async collectImmediateChildSummaries(ref: TicketRef): Promise<CardChild[]> {
    const childRefs = await this.childRefs(ref);
    const out: CardChild[] = [];
    for (const c of childRefs) {
      const p = await this.loadParsed(c);
      if (!p) continue;
      out.push({
        id: this.linkPrefix(c),
        slug: path.basename(c.id),
        type: p.frontmatter.type,
        status: p.frontmatter.status,
      });
    }
    return out;
  }

  /**
   * Walk up the parent chain to find the top-level ancestor (parent === null)
   * and re-render its board card. Used after any mutation to a nested ticket
   * so the ancestor card's child summary stays in sync.
   */
  private async refreshTopLevelBoardCard(start: TicketRef): Promise<void> {
    let cur: TicketRef | null = start;
    let topLevel: TicketRef | null = null;
    let topParsed: ParsedTicketFile | null = null;
    while (cur) {
      const parsed = await this.loadParsed(cur);
      if (!parsed) return;
      if (parsed.frontmatter.parent === null) {
        topLevel = cur;
        topParsed = parsed;
        break;
      }
      cur = { project: cur.project, id: parsed.frontmatter.parent };
    }
    if (!topLevel || !topParsed) return;
    const slug = path.basename(topLevel.id);
    await this.placeBoardCard(
      topLevel,
      topParsed.frontmatter.status,
      topParsed.frontmatter.priority,
      topParsed.frontmatter.type,
      slug,
    );
  }

  private async refreshParentChildren(parentRef: TicketRef): Promise<void> {
    const parsed = await this.loadParsed(parentRef);
    if (!parsed) return;
    const text = renderTicketFile({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      children: await this.collectChildEntries(parentRef),
      log: parsed.log,
      messages: parsed.messages,
      events: parsed.events,
    });
    await writeFileAtomic(this.ticketFile(parentRef), text);
  }

  // ── updating tickets ────────────────────────────────────────────────

  async updateTicket(ref: TicketRef, update: UpdateDTO): Promise<void> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) throw new Error(`ticket not found: ${ref.id}`);

    let nextBody = parsed.body;
    if (update.title !== undefined) {
      // Replace the leading `# Heading` line, or insert one.
      if (/^#\s+.+/m.test(nextBody)) {
        nextBody = nextBody.replace(/^#\s+.+/m, `# ${update.title}`);
      } else {
        nextBody = `# ${update.title}\n\n${nextBody}`;
      }
    }
    if (update.body !== undefined) {
      // Preserve heading if title field unchanged.
      const titleMatch = nextBody.match(/^#\s+(.+?)\s*$/m);
      const heading = titleMatch ? `# ${titleMatch[1]}\n` : "";
      nextBody = `${heading}\n${update.body.trimEnd()}\n`;
    }

    const fm: TicketFrontmatter = {
      ...parsed.frontmatter,
      status: update.status ?? parsed.frontmatter.status,
      priority: update.priority ?? parsed.frontmatter.priority,
      labels: update.labels ?? parsed.frontmatter.labels,
      scope: update.scope ?? parsed.frontmatter.scope,
      branch: update.branch ?? parsed.frontmatter.branch,
      pr_url: update.pr_url ?? parsed.frontmatter.pr_url,
      updated: new Date().toISOString(),
    };

    const text = renderTicketFile({
      frontmatter: fm,
      body: nextBody,
      children: await this.collectChildEntries(ref),
      log: parsed.log,
      messages: parsed.messages,
      events: parsed.events,
    });
    await writeFileAtomic(this.ticketFile(ref), text);

    if (fm.parent === null) {
      // Top-level: re-render its own card (status / priority / title / child
      // summary may all have changed). When status flips to Done the upsert
      // moves the card into the Done column atomically as part of this write.
      const slug = path.basename(ref.id);
      await this.placeBoardCard(ref, fm.status, fm.priority, fm.type, slug);
    } else {
      // Nested transition: refresh the immediate parent's ## Children
      // checklist (so its [ ] / [x] reflects this ticket's new status), then
      // walk up to refresh the top-level ancestor's board card sub-bullet.
      const parentRef: TicketRef = { project: ref.project, id: fm.parent };
      await this.refreshParentChildren(parentRef);
      await this.refreshTopLevelBoardCard(ref);
    }
  }

  // ── lock / progress / log ───────────────────────────────────────────

  async writeLock(ref: TicketRef, lock: Lock | null): Promise<void> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) throw new Error(`ticket not found: ${ref.id}`);
    const fm: TicketFrontmatter = {
      ...parsed.frontmatter,
      lock,
      updated: new Date().toISOString(),
    };
    const text = renderTicketFile({
      frontmatter: fm,
      body: parsed.body,
      children: await this.collectChildEntries(ref),
      log: parsed.log,
      messages: parsed.messages,
      events: parsed.events,
    });
    await writeFileAtomic(this.ticketFile(ref), text);
  }

  async appendLog(ref: TicketRef, line: string): Promise<void> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) throw new Error(`ticket not found: ${ref.id}`);
    const stamped = `[${new Date().toISOString()}] ${line}`;
    const text = renderTicketFile({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      children: await this.collectChildEntries(ref),
      log: [...parsed.log, stamped],
      messages: parsed.messages,
      events: parsed.events,
    });
    await writeFileAtomic(this.ticketFile(ref), text);
  }

  async postMessage(ref: TicketRef, message: Message): Promise<void> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) throw new Error(`ticket not found: ${ref.id}`);
    const text = renderTicketFile({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      children: await this.collectChildEntries(ref),
      log: parsed.log,
      messages: [...parsed.messages, message],
      events: parsed.events,
    });
    await writeFileAtomic(this.ticketFile(ref), text);
  }

  async readMessages(ref: TicketRef, since?: string): Promise<Message[]> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) return [];
    const all = [...parsed.messages].sort((a, b) => a.at.localeCompare(b.at));
    return since ? all.filter((m) => m.at > since) : all;
  }

  async appendEvent(ref: TicketRef, event: Event): Promise<void> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) throw new Error(`ticket not found: ${ref.id}`);
    // Cache maintenance: checkpoint and progress events carry post-state
    // for the visible scalar fields; bump the frontmatter cache in the
    // same write so getTicket sees a consistent snapshot without having
    // to derive on every read.
    let nextFm: TicketFrontmatter = parsed.frontmatter;
    if (event.type === "checkpoint" || event.type === "progress") {
      nextFm = {
        ...nextFm,
        update: event.update,
        progress_summary: event.progress_summary,
        updated: new Date().toISOString(),
      };
    }
    const text = renderTicketFile({
      frontmatter: nextFm,
      body: parsed.body,
      children: await this.collectChildEntries(ref),
      log: parsed.log,
      messages: parsed.messages,
      events: [...parsed.events, event],
    });
    await writeFileAtomic(this.ticketFile(ref), text);
  }

  async readEvents(
    ref: TicketRef,
    opts?: { since?: string; types?: ReadonlyArray<Event["type"]> },
  ): Promise<Event[]> {
    const parsed = await this.loadParsed(ref);
    if (!parsed) return [];
    let out = [...parsed.events].sort((a, b) => a.at.localeCompare(b.at));
    if (opts?.since) out = out.filter((e) => e.at > (opts.since as string));
    if (opts?.types && opts.types.length > 0) {
      const allow = new Set<Event["type"]>(opts.types);
      out = out.filter((e) => allow.has(e.type));
    }
    return out;
  }

  async readProjectEvents(
    project: string,
    opts?: { since?: string; types?: ReadonlyArray<Event["type"]> },
  ): Promise<Array<{ ref: TicketRef; event: Event }>> {
    const out: Array<{ ref: TicketRef; event: Event }> = [];
    await this.collectAllTicketRefs(project, async (ref) => {
      const events = await this.readEvents(ref, opts);
      for (const event of events) out.push({ ref, event });
    });
    out.sort((a, b) => a.event.at.localeCompare(b.event.at));
    return out;
  }

  /**
   * Watch every ticket file under the project directory and surface newly
   * appended events. Bookkeeping: per-ticket cursor of the last `at` we've
   * emitted, so re-reads don't double-emit. fs.watch fires on any change
   * to a file or its directory; we re-parse and diff against the cursor.
   *
   * Lossy cases we accept for v1:
   *  - File creation: the project-dir watcher fires on the new entry; we
   *    handle it by re-scanning on every event.
   *  - Editor swap-file moves (vim style): some editors rename in/out; the
   *    watcher catches those as separate events on the parent dir.
   */
  async watch(project: string, callback: WatcherCallback): Promise<WatcherUnsubscribe> {
    const projectRoot = this.projectDir(project);
    const cursor = new Map<string, string>(); // ticket id → last seen `at`
    let cancelled = false;

    const emitNew = async (ref: TicketRef): Promise<void> => {
      if (cancelled) return;
      try {
        const last = cursor.get(ref.id);
        const events = await this.readEvents(ref, last ? { since: last } : undefined);
        if (events.length === 0) return;
        const newest = events[events.length - 1]?.at;
        if (newest) cursor.set(ref.id, newest);
        callback(ref, events);
      } catch {
        // Ignore parse errors during in-flight writes; next change picks up.
      }
    };

    // Seed cursor from current state so we don't re-emit historical events.
    await this.collectAllTicketRefs(project, async (ref) => {
      const events = await this.readEvents(ref);
      const newest = events[events.length - 1]?.at;
      if (newest) cursor.set(ref.id, newest);
    });

    const watcher = fs.watch(projectRoot, { recursive: true }, (_eventType, filename) => {
      if (cancelled || !filename) return;
      if (!filename.endsWith("ticket.md")) return;
      const ref = this.refFromFilename(project, filename);
      if (!ref) return;
      void emitNew(ref);
    });

    return async () => {
      cancelled = true;
      watcher.close();
    };
  }

  /**
   * Walk the project's ticket tree and call `visit` for each ticket.md
   * found. Used by `readProjectEvents` and by `watch` to seed cursors.
   */
  private async collectAllTicketRefs(
    project: string,
    visit: (ref: TicketRef) => Promise<void>,
  ): Promise<void> {
    const root = this.projectDir(project);
    const walk = async (dir: string, idPrefix: string): Promise<void> => {
      const slugs = await listSubdirs(dir);
      for (const slug of slugs) {
        if (slug.startsWith(".")) continue;
        const sub = path.join(dir, slug);
        const id = idPrefix === "" ? slug : `${idPrefix}/${slug}`;
        if (await pathExists(path.join(sub, "ticket.md"))) {
          await visit({ project, id });
        }
        await walk(sub, id);
      }
    };
    if (!(await pathExists(root))) return;
    await walk(path.join(root, "tickets"), "tickets");
  }

  /**
   * Convert a path relative to the project root (e.g.
   * `tickets/foo/children/bar/ticket.md`) into a TicketRef. Returns null
   * for paths that don't look like a ticket file.
   */
  private refFromFilename(project: string, relPath: string): TicketRef | null {
    if (!relPath.endsWith("/ticket.md") && relPath !== "ticket.md") return null;
    const id = relPath.slice(0, relPath.length - "/ticket.md".length);
    if (id.length === 0) return null;
    return { project, id };
  }
}
