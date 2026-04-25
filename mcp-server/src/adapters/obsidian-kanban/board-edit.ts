import type { Priority, TicketType } from "../../domain/types.js";

export const BOARD_COLUMNS: readonly string[] = [
  "Backlog",
  "Todo",
  "In Progress",
  "In Review",
  "Done",
];

/**
 * Initial board.md scaffold. Each column is a `## Heading` block; the obsidian
 * `kanban-plugin: board` frontmatter makes the file render as a kanban board.
 */
export function initialBoardText(): string {
  const cols = BOARD_COLUMNS.map((c) => `## ${c}\n`).join("\n");
  return `---\n\nkanban-plugin: board\n\n---\n\n${cols}\n%% kanban:settings\n\`\`\`yaml\n{}\n\`\`\`\n%%\n`;
}

/**
 * The single thing we need to extract from board cards: the link target
 * (which is the ticket's path-id) and its slug. Everything else lives in
 * the ticket's own frontmatter.
 */
export type BoardCard = {
  id: string; // e.g. "tickets/auth-flow"
  slug: string; // display name, e.g. "auth-flow"
  done: boolean;
};

export function formatCard(args: {
  id: string;
  slug: string;
  priority: Priority;
  type: TicketType;
  done: boolean;
}): string {
  const tick = args.done ? "x" : " ";
  return `- [${tick}] [[${args.id}/ticket|${args.slug}]] #${args.priority} #${args.type}`;
}

const CARD_LINE_RE = /^- \[(x| )\] \[\[([^|\]]+)\|([^\]]+)\]\]/;

export function parseCardLine(line: string): BoardCard | null {
  const m = line.match(CARD_LINE_RE);
  if (!m) return null;
  const target = m[2] ?? "";
  return {
    id: target.replace(/\/ticket$/, ""),
    slug: m[3] ?? "",
    done: m[1] === "x",
  };
}

type ColumnIndex = { name: string; headerLine: number; nextHeaderLine: number };

function indexColumns(lines: readonly string[]): ColumnIndex[] {
  const headers: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(/^## (.+?)\s*$/);
    if (m && BOARD_COLUMNS.includes(m[1] ?? "")) {
      headers.push({ name: m[1] ?? "", line: i });
    }
  }
  // Stop at the kanban settings block if present.
  let endLine = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("%% kanban:settings")) {
      endLine = i;
      break;
    }
  }
  return headers.map((h, idx) => ({
    name: h.name,
    headerLine: h.line,
    nextHeaderLine: idx + 1 < headers.length ? (headers[idx + 1]?.line ?? endLine) : endLine,
  }));
}

/** Find every card in the board, with its column. */
export function listBoardCards(boardText: string): Array<BoardCard & { column: string }> {
  const lines = boardText.split("\n");
  const cols = indexColumns(lines);
  const cards: Array<BoardCard & { column: string }> = [];
  for (const c of cols) {
    for (let i = c.headerLine + 1; i < c.nextHeaderLine; i++) {
      const card = parseCardLine(lines[i] ?? "");
      if (card) cards.push({ ...card, column: c.name });
    }
  }
  return cards;
}

/** Remove all card lines that point at `id`, regardless of column. */
function removeCard(boardText: string, id: string): string {
  const lines = boardText.split("\n");
  const out: string[] = [];
  for (const l of lines) {
    const c = parseCardLine(l);
    if (c && c.id === id) continue;
    out.push(l);
  }
  return out.join("\n");
}

/**
 * Add a card line under the given column header, inserted after the existing
 * cards in that column (i.e. just before the next column header / settings).
 */
function addCard(boardText: string, column: string, cardLine: string): string {
  const lines = boardText.split("\n");
  const cols = indexColumns(lines);
  const target = cols.find((c) => c.name === column);
  if (!target) {
    throw new Error(`board.md is missing the "${column}" column`);
  }

  // Find last card line in this column; insert after it. If no cards, insert
  // right after the header (with a blank line above to keep the header clean).
  let insertAt = target.headerLine + 1;
  for (let i = target.headerLine + 1; i < target.nextHeaderLine; i++) {
    if (parseCardLine(lines[i] ?? "")) insertAt = i + 1;
  }

  // Skip the leading blank line after the header if the column is empty.
  if (insertAt === target.headerLine + 1 && (lines[insertAt] ?? "").trim() === "") {
    insertAt += 1;
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, cardLine, ...after].join("\n");
}

/**
 * Idempotent upsert: ensures exactly one card with this id exists, in the
 * given column, with the given line content. If the card was elsewhere it's
 * removed and re-added.
 */
export function upsertCard(
  boardText: string,
  args: {
    id: string;
    column: string;
    cardLine: string;
  },
): string {
  const removed = removeCard(boardText, args.id);
  return addCard(removed, args.column, args.cardLine);
}

export function deleteCard(boardText: string, id: string): string {
  return removeCard(boardText, id);
}
