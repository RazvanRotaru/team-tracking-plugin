import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Lock, Priority, TicketType } from "../../domain/types.js";

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
};

const SECTION_CHILDREN = "## Children";
const SECTION_LOG = "## Log";

export function parseTicketFile(text: string): ParsedTicketFile {
  // Frontmatter must start with `---\n`.
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

  // rest starts with optional blank line + body + optional ## Children + optional ## Log
  // Locate ## Children and ## Log section starts on lines of their own.
  const lines = rest.split("\n");
  let childrenStart = -1;
  let logStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === SECTION_CHILDREN && childrenStart === -1) childrenStart = i;
    if (lines[i] === SECTION_LOG && logStart === -1) logStart = i;
  }

  const bodyEnd = childrenStart !== -1 ? childrenStart : logStart !== -1 ? logStart : lines.length;
  let body = lines.slice(0, bodyEnd).join("\n");
  body = body.replace(/^\n+/, "").replace(/\n+$/, "");

  let logLines: string[] = [];
  if (logStart !== -1) {
    const after = lines.slice(logStart + 1);
    logLines = after.map((l) => l.replace(/\s+$/, "")).filter((l) => l.length > 0);
  }

  return { frontmatter: fm, body, log: logLines };
}

/**
 * Render a ticket.md given frontmatter, body, child entries, and log lines.
 *
 * Each child entry carries the absolute vault-relative wiki-link target
 * (e.g. `projects/Demo/tickets/foo/children/bar/ticket`) so the link pins
 * exactly one file regardless of how many other tickets share the same
 * `ticket.md` basename or local folder layout.
 */
export function renderTicketFile(args: {
  frontmatter: TicketFrontmatter;
  body: string;
  children: ReadonlyArray<{ linkTarget: string; slug: string; done: boolean }>;
  log: ReadonlyArray<string>;
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
  if (args.log.length > 0) {
    parts.push(SECTION_LOG, "");
    for (const l of args.log) parts.push(l);
    parts.push("");
  }
  return `${parts.join("\n")}`;
}
