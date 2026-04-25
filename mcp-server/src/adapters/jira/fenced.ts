/**
 * Fenced sections inside a Jira description, used as fallback storage for
 * fields we cannot put in custom fields (Scope, Branch, Update, Progress
 * Summary, Lock).
 *
 * Each section is delimited by HTML comment markers so it stays invisible
 * in rendered Jira:
 *
 *   <!-- tt:update -->...content...<!-- /tt:update -->
 *
 * Sections are read/written verbatim. Multi-line content is supported.
 */
const PREFIX = "tt:";

const startTag = (key: string) => `<!-- ${PREFIX}${key} -->`;
const endTag = (key: string) => `<!-- /${PREFIX}${key} -->`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function readFenced(description: string, key: string): string | null {
  const re = new RegExp(`${escapeRe(startTag(key))}([\\s\\S]*?)${escapeRe(endTag(key))}`);
  const m = description.match(re);
  return m ? (m[1] ?? "").replace(/^\n/, "").replace(/\n$/, "") : null;
}

export function writeFenced(description: string, key: string, value: string | null): string {
  const re = new RegExp(`\\n*${escapeRe(startTag(key))}[\\s\\S]*?${escapeRe(endTag(key))}\\n*`);
  const stripped = description.replace(re, "\n");
  if (value === null) {
    return stripped.replace(/\n+$/, "\n").replace(/^\n+/, "");
  }
  const block = `\n${startTag(key)}\n${value}\n${endTag(key)}\n`;
  return `${stripped.replace(/\n+$/, "")}${block}`;
}
