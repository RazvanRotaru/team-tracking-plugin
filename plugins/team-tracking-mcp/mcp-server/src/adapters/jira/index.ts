import { deriveLockState } from "../../domain/lock.js";
import type {
  CreateTicketDTO,
  Event,
  Lock,
  Message,
  TicketDTO,
  TicketRef,
  TicketSummaryDTO,
  TicketType,
  UpdateDTO,
} from "../../domain/types.js";
import type {
  AdapterConfig,
  TrackerAdapter,
  WatcherCallback,
  WatcherUnsubscribe,
} from "../types.js";
import { readFenced, writeFenced } from "./fenced.js";
import { type JiraAuth, type JiraIssue, JiraRest } from "./rest.js";
import {
  ISSUE_TYPE_FROM_NEUTRAL,
  ISSUE_TYPE_TO_NEUTRAL,
  PRIORITY_FROM_JIRA,
  PRIORITY_TO_JIRA,
  StatusMapper,
} from "./status-map.js";
import { type JiraWebhookReceiver, subscribeReceiver } from "./webhook.js";

export { JiraWebhookReceiver } from "./webhook.js";

export type JiraAdapterCustomFieldIds = {
  update?: string;
  progress_summary?: string;
  lock?: string;
  scope?: string;
  branch?: string;
};

export type JiraAdapterParams = JiraAuth & {
  statusMap: Record<string, string>;
  customFieldIds?: JiraAdapterCustomFieldIds;
  projects: Array<{ name: string; adapterProjectRef: string }>;
  fetchImpl?: typeof fetch;
  /**
   * Polling interval for `watch()` when no webhook receiver is configured.
   * Pure HTTP fallback; usually 5-15s is reasonable.
   */
  watchPollMs?: number;
  /**
   * Pre-started JiraWebhookReceiver. When provided, `watch()` registers
   * with it for push delivery and skips polling entirely. The caller is
   * responsible for the receiver's lifecycle (start/stop) — the adapter
   * only subscribes/unsubscribes.
   */
  webhookReceiver?: JiraWebhookReceiver;
};

const FENCED_KEYS = {
  update: "update",
  progress_summary: "progress",
  lock: "lock",
  scope: "scope",
  branch: "branch",
} as const;

const PARENT_LINK_TYPE = "is parent of";

/**
 * Convert plain text to a minimal Atlassian Document Format value (used by
 * Jira v3 description / comment endpoints).
 */
function toAdf(text: string): unknown {
  if (text.length === 0) {
    return { type: "doc", version: 1, content: [] };
  }
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line.length === 0 ? [] : [{ type: "text", text: line }],
    })),
  };
}

/** Best-effort flattening of an ADF body back to plain text. */
function fromAdf(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const root = adf as { content?: unknown[] };
  if (!Array.isArray(root.content)) return "";
  const lines: string[] = [];
  for (const node of root.content) {
    if (typeof node !== "object" || node === null) continue;
    const para = node as { type?: string; content?: unknown[] };
    if (para.type !== "paragraph" || !Array.isArray(para.content)) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const child of para.content) {
      if (typeof child === "object" && child !== null) {
        const c = child as { type?: string; text?: string };
        if (c.type === "text" && typeof c.text === "string") line += c.text;
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}

export class JiraAdapter implements TrackerAdapter {
  private readonly rest: JiraRest;
  private readonly statusMapper: StatusMapper;
  private readonly customFieldIds: JiraAdapterCustomFieldIds;
  private readonly projects: Map<string, string>; // canonical name → Jira project key
  private readonly watchPollMs: number;
  private readonly webhookReceiver: JiraWebhookReceiver | null;

  constructor(params: JiraAdapterParams) {
    this.rest = new JiraRest(
      { baseUrl: params.baseUrl, email: params.email, apiToken: params.apiToken },
      params.fetchImpl,
    );
    this.statusMapper = new StatusMapper(params.statusMap);
    this.customFieldIds = params.customFieldIds ?? {};
    this.projects = new Map(params.projects.map((p) => [p.name, p.adapterProjectRef]));
    this.watchPollMs = params.watchPollMs ?? 10_000;
    this.webhookReceiver = params.webhookReceiver ?? null;
  }

  async init(_config: AdapterConfig): Promise<void> {
    // No-op: Jira is the system of record. Future work: validate the project
    // keys exist by hitting /rest/api/3/project, and verify the status map
    // covers the project's workflow.
  }

  // ── helpers ────────────────────────────────────────────────────────

  private projectKey(canonical: string): string {
    const k = this.projects.get(canonical);
    if (!k) throw new Error(`unknown project "${canonical}"`);
    return k;
  }

  private async readField(
    issue: JiraIssue,
    canonicalKey: keyof typeof FENCED_KEYS,
  ): Promise<string | null> {
    const cfId = this.customFieldIds[canonicalKey];
    if (cfId && cfId in issue.fields) {
      const v = issue.fields[cfId];
      if (typeof v === "string") return v.length > 0 ? v : null;
      if (v === null) return null;
    }
    const desc = issue.fields.description;
    const body = typeof desc === "string" ? desc : fromAdf(desc);
    return readFenced(body, FENCED_KEYS[canonicalKey]);
  }

  private async writeFields(
    key: string,
    issue: JiraIssue,
    updates: Partial<Record<keyof typeof FENCED_KEYS, string | null>>,
  ): Promise<void> {
    const fieldEdits: Record<string, unknown> = {};
    let descBody = (() => {
      const desc = issue.fields.description;
      return typeof desc === "string" ? desc : fromAdf(desc);
    })();
    let descChanged = false;

    for (const [k, value] of Object.entries(updates) as Array<
      [keyof typeof FENCED_KEYS, string | null]
    >) {
      const cfId = this.customFieldIds[k];
      if (cfId) {
        fieldEdits[cfId] = value;
      } else {
        descBody = writeFenced(descBody, FENCED_KEYS[k], value);
        descChanged = true;
      }
    }

    if (descChanged) fieldEdits.description = toAdf(descBody);
    if (Object.keys(fieldEdits).length > 0) {
      await this.rest.editIssue(key, fieldEdits);
    }
  }

  // ── reads ──────────────────────────────────────────────────────────

  async getTicket(ref: TicketRef): Promise<TicketDTO | null> {
    let issue: JiraIssue;
    try {
      issue = await this.rest.getIssue(ref.id);
    } catch (e) {
      if ((e as Error).message.includes(" 404")) return null;
      throw e;
    }
    return this.toDTO(ref, issue);
  }

  private async toDTO(ref: TicketRef, issue: JiraIssue): Promise<TicketDTO> {
    const fields = issue.fields;
    const summary = typeof fields.summary === "string" ? fields.summary : "";
    const description = (() => {
      const d = fields.description;
      return typeof d === "string" ? d : fromAdf(d);
    })();
    const status = (() => {
      const s = fields.status as { name?: string } | undefined;
      const native = s?.name ?? "";
      return this.statusMapper.hasJira(native) ? this.statusMapper.fromJira(native) : native;
    })();
    const priority = (() => {
      const p = fields.priority as { name?: string } | undefined;
      const native = p?.name ?? "Medium";
      return PRIORITY_FROM_JIRA[native] ?? "P2";
    })();
    const issueType = (() => {
      const t = fields.issuetype as { name?: string } | undefined;
      const native = t?.name ?? "Task";
      return ISSUE_TYPE_TO_NEUTRAL[native] ?? "task";
    })();
    const labels = Array.isArray(fields.labels) ? (fields.labels as string[]) : [];
    const parent = await this.resolveParent(ref.project, issue);
    const children = await this.resolveChildren(ref.project, issue.key);

    const update = await this.readField(issue, "update");
    const progressSummary = await this.readField(issue, "progress_summary");
    const lockJson = await this.readField(issue, "lock");
    const scope = await this.readField(issue, "scope");
    const branch = await this.readField(issue, "branch");
    const lock: Lock | null = lockJson ? (JSON.parse(lockJson) as Lock) : null;

    return {
      ref,
      type: issueType as TicketType,
      parent,
      title: summary,
      body: stripFencedAll(description),
      status,
      priority,
      labels,
      scope,
      branch,
      pr_url: null, // remote-link plumbing not implemented in v1
      update,
      progress_summary: progressSummary,
      lock_state: deriveLockState(lock),
      lock,
      created: typeof fields.created === "string" ? fields.created : "",
      updated: typeof fields.updated === "string" ? fields.updated : "",
      children,
    };
  }

  private async resolveParent(project: string, issue: JiraIssue): Promise<TicketRef | null> {
    // Native Sub-task: parent field carries it.
    const native = issue.fields.parent as { key?: string } | undefined;
    if (native?.key) return { project, id: native.key };
    // Story → Task via "is parent of" issue link (faked fourth level).
    const links = issue.fields.issuelinks as
      | Array<{ type?: { inward?: string }; inwardIssue?: { key?: string } }>
      | undefined;
    if (Array.isArray(links)) {
      for (const l of links) {
        if (l.type?.inward === PARENT_LINK_TYPE && l.inwardIssue?.key) {
          return { project, id: l.inwardIssue.key };
        }
      }
    }
    return null;
  }

  private async resolveChildren(project: string, key: string): Promise<TicketRef[]> {
    // Native (sub-tasks under a parent) plus link-based.
    const jqlNative = `parent = ${key}`;
    const jqlLinked = `issue in linkedIssues("${key}", "${PARENT_LINK_TYPE}")`;
    const jql = `${jqlNative} OR (${jqlLinked})`;
    const r = await this.rest.searchJql(jql, ["summary"]);
    return r.issues.map((i) => ({ project, id: i.key }));
  }

  async listChildren(ref: TicketRef): Promise<TicketDTO[]> {
    const childRefs = await this.resolveChildren(ref.project, ref.id);
    const out: TicketDTO[] = [];
    for (const c of childRefs) {
      const t = await this.getTicket(c);
      if (t) out.push(t);
    }
    return out;
  }

  async listBoard(project: string): Promise<TicketSummaryDTO[]> {
    const key = this.projectKey(project);
    const wanted = ["Backlog", "Todo", "In Progress"]
      .filter((c) => this.statusMapper.hasCanonical(c))
      .map((c) => `"${this.statusMapper.toJira(c)}"`);
    if (wanted.length === 0) return [];
    const jql = `project = ${key} AND parent is EMPTY AND status in (${wanted.join(", ")}) ORDER BY priority DESC`;
    const r = await this.rest.searchJql(jql);
    const out: TicketSummaryDTO[] = [];
    for (const issue of r.issues) {
      const dto = await this.toDTO({ project, id: issue.key }, issue);
      out.push({
        ref: dto.ref,
        type: dto.type,
        title: dto.title,
        status: dto.status,
        priority: dto.priority,
        scope: dto.scope,
        branch: dto.branch,
        update: dto.update,
        lock_state: dto.lock_state,
      });
    }
    return out;
  }

  // ── writes ─────────────────────────────────────────────────────────

  async createTicket(project: string, draft: CreateTicketDTO): Promise<TicketRef> {
    const projectKey = this.projectKey(project);

    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      issuetype: { name: ISSUE_TYPE_FROM_NEUTRAL[draft.type] },
      summary: draft.title,
      description: toAdf(draft.body ?? ""),
      priority: { name: PRIORITY_TO_JIRA[draft.priority ?? "P2"] },
      labels: draft.labels ?? [],
    };

    let useLink: { parentKey: string } | null = null;
    if (draft.parent) {
      // Native parent: subtask → parent task; epic link uses parent in modern Jira.
      // For story → task we fall back to an "is parent of" issue link.
      if (draft.type === "subtask" || draft.type === "story") {
        fields.parent = { key: draft.parent.id };
      } else if (draft.type === "task") {
        // We don't know the parent's type without fetching; cheap path: use
        // parent for epic, link for story. Inspect parent's issue type.
        const p = await this.rest.getIssue(draft.parent.id, ["issuetype"]);
        const ptype = (p.fields.issuetype as { name?: string } | undefined)?.name ?? "";
        if (ptype === "Story") {
          useLink = { parentKey: draft.parent.id };
        } else {
          fields.parent = { key: draft.parent.id };
        }
      }
    }

    if (draft.scope !== undefined) {
      const cf = this.customFieldIds.scope;
      if (cf) fields[cf] = draft.scope;
    }

    const created = await this.rest.createIssue(fields);

    if (!this.customFieldIds.scope && draft.scope !== undefined) {
      // Couldn't set scope inline; fall back to fenced-section in description.
      const issue = await this.rest.getIssue(created.key);
      await this.writeFields(created.key, issue, { scope: draft.scope });
    }

    if (useLink) {
      await this.rest.createIssueLink({
        type: PARENT_LINK_TYPE,
        inwardKey: useLink.parentKey,
        outwardKey: created.key,
      });
    }

    return { project, id: created.key };
  }

  async updateTicket(ref: TicketRef, update: UpdateDTO): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (update.title !== undefined) fields.summary = update.title;
    if (update.priority !== undefined) {
      fields.priority = { name: PRIORITY_TO_JIRA[update.priority] };
    }
    if (update.labels !== undefined) fields.labels = update.labels;
    if (update.body !== undefined) fields.description = toAdf(update.body);

    // status changes go through the transitions API, not edit.
    if (update.status !== undefined) {
      const target = this.statusMapper.toJira(update.status);
      const t = await this.rest.listTransitions(ref.id);
      const match = t.transitions.find((tr) => tr.to.name === target);
      if (!match) {
        throw new Error(`no transition to "${target}" available from current state`);
      }
      await this.rest.transitionIssue(ref.id, match.id);
    }

    if (Object.keys(fields).length > 0) {
      await this.rest.editIssue(ref.id, fields);
    }

    // Fields handled either as custom field or fenced section.
    const issue = await this.rest.getIssue(ref.id);
    const fenced: Partial<Record<keyof typeof FENCED_KEYS, string | null>> = {};
    if (update.scope !== undefined) fenced.scope = update.scope ?? null;
    if (update.branch !== undefined) fenced.branch = update.branch ?? null;
    if (Object.keys(fenced).length > 0) {
      await this.writeFields(ref.id, issue, fenced);
    }

    // pr_url could be a remote link; v1 stores only via custom field if the
    // user has wired one. Otherwise it's silently dropped.
  }

  async writeLock(ref: TicketRef, lock: Lock | null): Promise<void> {
    const issue = await this.rest.getIssue(ref.id);
    await this.writeFields(ref.id, issue, {
      lock: lock === null ? null : JSON.stringify(lock),
    });
  }

  async appendLog(ref: TicketRef, line: string): Promise<void> {
    await this.rest.addComment(ref.id, line);
  }

  /**
   * Steering messages are stored as comments with a sentinel first line so
   * we can distinguish them from regular log/audit comments. Format:
   *
   *   STEERING id=msg_... at=... from=... kind=... [in_reply_to=...]
   *   <body lines>
   */
  async postMessage(ref: TicketRef, message: Message): Promise<void> {
    await this.rest.addComment(ref.id, formatSteeringComment(message));
  }

  async readMessages(ref: TicketRef, since?: string): Promise<Message[]> {
    const { comments } = await this.rest.listComments(ref.id);
    const out: Message[] = [];
    for (const c of comments) {
      const text = typeof c.body === "string" ? c.body : fromAdf(c.body);
      const parsed = parseSteeringComment(text);
      if (!parsed) continue;
      out.push(parsed);
    }
    out.sort((a, b) => a.at.localeCompare(b.at));
    return since ? out.filter((m) => m.at > since) : out;
  }

  /**
   * Unified event log: each event is stored as a Jira comment with a
   * recognizable first line:
   *
   *   [event:<type>] <compact-json-payload>
   *
   * The `[event:` prefix is unmistakable, the type is inline for cheap
   * filtering, and the JSON payload is the full Event so a future reader
   * doesn't need to reconstruct anything from comment metadata.
   */
  async appendEvent(ref: TicketRef, event: Event): Promise<void> {
    await this.rest.addComment(ref.id, formatEventComment(event));
    // Cache maintenance: checkpoint and progress events carry the
    // post-state for the visible scalar fields. Update the cache (custom
    // fields or fenced description) so getTicket doesn't have to read
    // the full comment list to derive `update` / `progress_summary`.
    if (event.type === "checkpoint" || event.type === "progress") {
      const issue = await this.rest.getIssue(ref.id);
      await this.writeFields(ref.id, issue, {
        update: event.update,
        progress_summary: event.progress_summary,
      });
    }
  }

  async readEvents(
    ref: TicketRef,
    opts?: { since?: string; types?: ReadonlyArray<Event["type"]> },
  ): Promise<Event[]> {
    const { comments } = await this.rest.listComments(ref.id);
    const out: Event[] = [];
    for (const c of comments) {
      const text = typeof c.body === "string" ? c.body : fromAdf(c.body);
      const parsed = parseEventComment(text);
      if (!parsed) continue;
      out.push(parsed);
    }
    out.sort((a, b) => a.at.localeCompare(b.at));
    let filtered = out;
    if (opts?.since) filtered = filtered.filter((e) => e.at > (opts.since as string));
    if (opts?.types && opts.types.length > 0) {
      const allow = new Set<Event["type"]>(opts.types);
      filtered = filtered.filter((e) => allow.has(e.type));
    }
    return filtered;
  }

  /**
   * Watch for events. Two modes:
   *
   * 1. **Webhook receiver** (push, low-latency): when a `webhookReceiver`
   *    was passed in `JiraAdapterParams`, the adapter subscribes to it and
   *    fires the callback for every `comment_created` payload whose body
   *    parses as an event. The caller owns the receiver's HTTP lifecycle
   *    (port binding, Jira-side webhook configuration). This is the
   *    real-time path.
   *
   * 2. **Polling fallback**: when no receiver is configured, the adapter
   *    polls each board ticket's comments at `watchPollMs` cadence and
   *    diffs against a per-issue cursor. Higher latency floor, but works
   *    in any deployment without a public-reachable HTTP endpoint.
   */
  async watch(project: string, callback: WatcherCallback): Promise<WatcherUnsubscribe> {
    if (this.webhookReceiver) {
      const projectKey = this.projects.get(project);
      const isProjectIssue = (issueKey: string): boolean => {
        if (!projectKey) return false;
        // Jira issue keys are `<PROJECT>-<n>` (e.g. ACME-42). Match the
        // prefix so we ignore events for issues outside this adapter's
        // configured projects.
        return issueKey.startsWith(`${projectKey}-`);
      };
      const unsubscribe = subscribeReceiver(
        this.webhookReceiver,
        project,
        isProjectIssue,
        callback,
      );
      return async () => {
        unsubscribe();
      };
    }
    return this.watchPolling(project, callback);
  }

  private async watchPolling(
    project: string,
    callback: WatcherCallback,
  ): Promise<WatcherUnsubscribe> {
    const cursor = new Map<string, string>(); // ticket id → last seen `at`
    let cancelled = false;

    // Seed cursors so we don't re-emit historical events.
    const seedRefs = (await this.listBoard(project)).map((s) => s.ref);
    for (const ref of seedRefs) {
      try {
        const events = await this.readEvents(ref);
        const newest = events[events.length - 1]?.at;
        if (newest) cursor.set(ref.id, newest);
      } catch {
        // Best-effort seed; failures resolve themselves on the next sweep.
      }
    }

    const sweep = async (): Promise<void> => {
      if (cancelled) return;
      let refs: TicketRef[];
      try {
        refs = (await this.listBoard(project)).map((s) => s.ref);
      } catch {
        return;
      }
      for (const ref of refs) {
        if (cancelled) return;
        try {
          const last = cursor.get(ref.id);
          const events = await this.readEvents(ref, last ? { since: last } : undefined);
          if (events.length === 0) continue;
          const newest = events[events.length - 1]?.at;
          if (newest) cursor.set(ref.id, newest);
          callback(ref, events);
        } catch {
          // Skip; next sweep retries.
        }
      }
    };

    const interval = setInterval(() => {
      void sweep();
    }, this.watchPollMs);

    return async () => {
      cancelled = true;
      clearInterval(interval);
    };
  }
}

const STEERING_PREFIX = "STEERING";

function formatSteeringComment(m: Message): string {
  const meta = [
    `id=${escapeMeta(m.id)}`,
    `at=${escapeMeta(m.at)}`,
    `from=${escapeMeta(m.from)}`,
    `kind=${escapeMeta(m.kind)}`,
    m.in_reply_to ? `in_reply_to=${escapeMeta(m.in_reply_to)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${STEERING_PREFIX} ${meta}\n${m.body}`;
}

function parseSteeringComment(text: string): Message | null {
  if (!text.startsWith(`${STEERING_PREFIX} `)) return null;
  const newline = text.indexOf("\n");
  const head = newline === -1 ? text : text.slice(0, newline);
  const body = newline === -1 ? "" : text.slice(newline + 1).replace(/^\n+|\n+$/g, "");
  const meta: Record<string, string> = {};
  for (const token of head.slice(STEERING_PREFIX.length + 1).split(/\s+/)) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    meta[token.slice(0, eq)] = unescapeMeta(token.slice(eq + 1));
  }
  if (!meta.id || !meta.at || !meta.from) return null;
  return {
    id: meta.id,
    at: meta.at,
    from: meta.from,
    kind: meta.kind ?? "info",
    body,
    in_reply_to: meta.in_reply_to ?? null,
  };
}

function escapeMeta(value: string): string {
  return value.replace(/[%\s=]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function unescapeMeta(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}

const FENCED_RE_ALL = /\n*<!--\s*tt:([a-z_]+)\s*-->[\s\S]*?<!--\s*\/tt:\1\s*-->\n*/g;
function stripFencedAll(description: string): string {
  return description.replace(FENCED_RE_ALL, "\n").replace(/^\n+|\n+$/g, "");
}

const EVENT_PREFIX_RE = /^\[event:([a-z_]+)\]\s+/;

function formatEventComment(event: Event): string {
  return `[event:${event.type}] ${JSON.stringify(event)}`;
}

function parseEventComment(text: string): Event | null {
  const m = text.match(EVENT_PREFIX_RE);
  if (!m) return null;
  const json = text.slice(m[0].length).trimEnd();
  try {
    const parsed = JSON.parse(json) as Event;
    if (parsed && typeof parsed === "object" && "type" in parsed && "id" in parsed) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
