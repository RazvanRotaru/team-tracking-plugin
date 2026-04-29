import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Event, Lock, Message, Priority, TicketType } from "../../domain/types.js";

export type TicketFrontmatter = {
  type: TicketType;
  parent: string | null; // path-id of parent, e.g. "tickets/foo"
  status: string;
  priority: Priority;
  labels: string[];
  scope: string | null;
  branch: string | null;
  pr_url: string | null;
  update: string | null;
  progress_summary: string | null;
  lock: Lock | null;
  created: string;
  updated: string;
};

export type ParsedTicketFile = {
  frontmatter: TicketFrontmatter;
  body: string;
  log: string[]; // raw log lines, no trailing newline
  messages: Message[]; // steering channel (legacy projection)
  events: Event[]; // unified append-only event log
};

const SECTION_CHILDREN = "## Children";
const SECTION_STEERING = "## Steering";
const SECTION_LOG = "## Log";
const SECTION_EVENTS = "## Events";

export function parseTicketFile(text: string): ParsedTicketFile {
  if (!text.startsWith("---\n")) {
    throw new Error("ticket.md missing leading frontmatter");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) {
    throw new Error("ticket.md frontmatter not terminated");
  }
  const yamlBlock = text.slice(4, end);
  const rest = text.slice(end + 5); // after `\n---\n`
  const fm = parseYaml(yamlBlock) as TicketFrontmatter;

  // Locate section headers on their own line.
  const lines = rest.split("\n");
  const idx = (header: string) => lines.indexOf(header);
  const childrenStart = idx(SECTION_CHILDREN);
  const steeringStart = idx(SECTION_STEERING);
  const logStart = idx(SECTION_LOG);
  const eventsStart = idx(SECTION_EVENTS);

  // Body ends at the first section header that's present.
  const sectionStarts = [childrenStart, steeringStart, logStart, eventsStart]
    .filter((i) => i !== -1)
    .sort((a, b) => a - b);
  const bodyEnd = sectionStarts.length > 0 ? (sectionStarts[0] ?? lines.length) : lines.length;
  let body = lines.slice(0, bodyEnd).join("\n");
  body = body.replace(/^\n+/, "").replace(/\n+$/, "");

  // Each section runs until the next section header or EOF.
  const sectionEnd = (start: number): number => {
    if (start === -1) return -1;
    const next = sectionStarts.find((s) => s > start);
    return next ?? lines.length;
  };

  let logLines: string[] = [];
  if (logStart !== -1) {
    const slice = lines.slice(logStart + 1, sectionEnd(logStart));
    logLines = slice.map((l) => l.replace(/\s+$/, "")).filter((l) => l.length > 0);
  }

  let messages: Message[] = [];
  if (steeringStart !== -1) {
    const slice = lines.slice(steeringStart + 1, sectionEnd(steeringStart)).join("\n");
    messages = parseSteeringSection(slice);
  }

  let events: Event[] = [];
  if (eventsStart !== -1) {
    const slice = lines.slice(eventsStart + 1, sectionEnd(eventsStart));
    events = parseEventsSection(slice);
  }

  return { frontmatter: fm, body, log: logLines, messages, events };
}

/**
 * Render a ticket.md given frontmatter, body, child entries, log lines,
 * steering messages, and the unified event log. Children carry absolute
 * vault-relative wiki-link targets. The Events section is JSONL — one
 * compact JSON object per line — so the file stays diff-friendly and the
 * watcher can detect changes by line count.
 */
export function renderTicketFile(args: {
  frontmatter: TicketFrontmatter;
  body: string;
  children: ReadonlyArray<{ linkTarget: string; slug: string; done: boolean }>;
  log: ReadonlyArray<string>;
  messages?: ReadonlyArray<Message>;
  events?: ReadonlyArray<Event>;
}): string {
  const fm = stringifyYaml(args.frontmatter, { lineWidth: 0 }).trimEnd();
  const parts = ["---", fm, "---", ""];
  if (args.body.trim().length > 0) {
    parts.push(args.body.trimEnd(), "");
  }
  if (args.children.length > 0) {
    parts.push(SECTION_CHILDREN, "");
    for (const c of args.children) {
      const tick = c.done ? "x" : " ";
      parts.push(`- [${tick}] [[${c.linkTarget}|${c.slug}]]`);
    }
    parts.push("");
  }
  if (args.messages && args.messages.length > 0) {
    parts.push(SECTION_STEERING, "");
    for (const m of args.messages) {
      parts.push(renderSteeringMessage(m));
      parts.push("");
    }
  }
  if (args.log.length > 0) {
    parts.push(SECTION_LOG, "");
    for (const l of args.log) parts.push(l);
    parts.push("");
  }
  if (args.events && args.events.length > 0) {
    parts.push(SECTION_EVENTS, "");
    for (const ev of args.events) parts.push(...renderEventBullet(ev));
    parts.push("");
    parts.push("<details>");
    parts.push("<summary>Raw event log (JSONL)</summary>", "");
    parts.push("```jsonl");
    for (const ev of args.events) parts.push(JSON.stringify(ev));
    parts.push("```");
    parts.push("");
    parts.push("</details>", "");
  }
  return `${parts.join("\n")}`;
}

/**
 * Human-readable rendering of a single event. Returns one or more lines —
 * a top bullet with timestamp + type + actor, optional indented detail
 * lines for richer event types. The canonical machine-readable form lives
 * in the JSONL fence below; this is a sibling projection regenerated on
 * every render, so it cannot drift.
 */
function renderEventBullet(ev: Event): string[] {
  const ts = formatEventTime(ev.at);
  switch (ev.type) {
    case "created": {
      const parent = ev.parent ? ` (parent: \`${ev.parent.id}\`)` : "";
      return [`- **${ts}** · created ${ev.ticket_type} "${ev.title}" · ${ev.priority}${parent}`];
    }
    case "status_change": {
      const who = ev.by ? ` · by \`${ev.by}\`` : "";
      return [`- **${ts}** · status · ${ev.from_status ?? "—"} → ${ev.to_status}${who}`];
    }
    case "lock_change": {
      const recovered = ev.recovered_from ? ` (recovered from \`${ev.recovered_from}\`)` : "";
      const finalSt = ev.final_status ? ` · → ${ev.final_status}` : "";
      return [`- **${ts}** · lock · ${ev.action} by \`${ev.owner}\`${recovered}${finalSt}`];
    }
    case "checkpoint": {
      const sha = ev.commit_id.length > 7 ? ev.commit_id.slice(0, 7) : ev.commit_id;
      const lines = [`- **${ts}** · checkpoint · \`${ev.by}\` @ \`${sha}\``];
      if (ev.update) lines.push(`  - update: ${oneLine(ev.update)}`);
      if (ev.progress_summary) lines.push(`  - progress: ${oneLine(ev.progress_summary)}`);
      return lines;
    }
    case "progress": {
      const lines = [`- **${ts}** · progress · \`${ev.by}\``];
      if (ev.status) lines.push(`  - status: → ${ev.status}`);
      if (ev.update) lines.push(`  - update: ${oneLine(ev.update)}`);
      if (ev.progress_summary) lines.push(`  - progress: ${oneLine(ev.progress_summary)}`);
      return lines;
    }
    case "log": {
      const who = ev.by ? `\`${ev.by}\`` : "—";
      return [`- **${ts}** · log · ${who} · ${oneLine(ev.line)}`];
    }
    case "message": {
      const reply = ev.in_reply_to ? ` · ↩ \`${ev.in_reply_to}\`` : "";
      const lines = [`- **${ts}** · ${ev.kind} from \`${ev.from}\`${reply}`];
      if (ev.body) lines.push(`  - ${oneLine(ev.body)}`);
      return lines;
    }
    case "fields_change": {
      const fields = Object.keys(ev.changes);
      const who = ev.by ? ` · by \`${ev.by}\`` : "";
      return [`- **${ts}** · fields${who} · ${fields.join(", ")}`];
    }
  }
}

/**
 * `2026-04-29T10:30:00.123Z` → `2026-04-29 10:30:00Z`. Falls back to the
 * raw string if it doesn't parse, so we never lose information.
 */
function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** Flatten newlines and runs of whitespace into single spaces for one-line bullets. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Event log section. Each event is one line of JSON inside a fenced
 * `jsonl` code block. The fence keeps Obsidian's renderer from trying to
 * parse the JSON as markdown; lines outside the fence are ignored so a
 * human can annotate above/below if they want.
 */
function parseEventsSection(sliceLines: string[]): Event[] {
  const events: Event[] = [];
  let inFence = false;
  for (const raw of sliceLines) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Event;
      if (parsed && typeof parsed === "object" && "type" in parsed && "id" in parsed) {
        events.push(parsed);
      }
    } catch {
      // Tolerate malformed lines — skip silently. A future migration may
      // surface these via a warning channel.
    }
  }
  return events;
}

/**
 * Steering message wire format:
 *
 *   <!-- msg id=... at=... from=... kind=... in_reply_to=... -->
 *   <body lines, may be empty or multi-line>
 *
 * Both human-readable (renders as a comment + paragraph in Obsidian) and
 * machine-parseable (each marker is unique per message).
 */
function renderSteeringMessage(m: Message): string {
  const meta = [
    `id=${escapeMeta(m.id)}`,
    `at=${escapeMeta(m.at)}`,
    `from=${escapeMeta(m.from)}`,
    `kind=${escapeMeta(m.kind)}`,
    m.in_reply_to ? `in_reply_to=${escapeMeta(m.in_reply_to)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<!-- msg ${meta} -->\n${m.body}`;
}

const META_RE = /<!--\s*msg\s+(.+?)\s*-->/g;

export function parseSteeringSection(text: string): Message[] {
  const out: Message[] = [];
  // Find every marker. Each message body is the text between this marker
  // and the next marker (or EOF for the last one).
  const markers: Array<{ start: number; end: number; meta: string }> = [];
  for (const m of text.matchAll(META_RE)) {
    if (m.index === undefined) continue;
    markers.push({ start: m.index, end: m.index + m[0].length, meta: m[1] ?? "" });
  }
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!marker) continue;
    const next = markers[i + 1];
    const bodyStart = marker.end;
    const bodyEnd = next ? next.start : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/^\n+/, "").replace(/\n+$/, "");
    const meta = parseMeta(marker.meta);
    out.push({
      id: meta.id ?? "",
      at: meta.at ?? "",
      from: meta.from ?? "",
      kind: meta.kind ?? "info",
      body,
      in_reply_to: meta.in_reply_to ?? null,
    });
  }
  return out;
}

function escapeMeta(value: string): string {
  // Spaces and `=` are the only chars that would break the simple parser.
  // We percent-encode them; everything else is kept readable.
  return value.replace(/[%\s=]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function unescapeMeta(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
}

function parseMeta(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on whitespace, then on the first `=` of each token.
  for (const token of raw.split(/\s+/)) {
    if (token.length === 0) continue;
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    const k = token.slice(0, eq);
    const v = token.slice(eq + 1);
    out[k] = unescapeMeta(v);
  }
  return out;
}
