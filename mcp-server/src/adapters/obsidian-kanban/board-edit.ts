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
  return `---\n\nkanban-plugin: board\n\n---\n\n${cols}\n%% kanban:settings\n\`\`\`\n{}\n\`\`\`\n%%\n`;
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

/** Immediate-child summary surfaced inside the parent's card body. */
export type CardChild = {
  id: string;
  slug: string;
  type: TicketType;
  status: string;
};

export function formatCard(args: {
  id: string;
  slug: string;
  priority: Priority;
  type: TicketType;
  done: boolean;
  children?: ReadonlyArray<CardChild>;
}): string {
  const tick = args.done ? "x" : " ";
  const head = `- [${tick}] [[${args.id}/ticket|${args.slug}]] #${args.priority} #${args.type}`;
  if (!args.children || args.children.length === 0) return head;
  const tail = args.children
    .map((c) => `\t- [[${c.id}/ticket|${c.slug}]] · ${c.type} · ${c.status}`)
    .join("\n");
  return `${head}\n${tail}`;
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

function isContinuation(line: string): boolean {
  // Indented lines (tab or space-prefixed) belong to the preceding card.
  // Blank lines and non-indented lines do not.
  return line.startsWith("\t") || line.startsWith(" ");
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

/** Find every card in the board, with its column. Sub-bullets are ignored. */
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

/**
 * Remove the card whose head line points at `id`, plus any indented
 * continuation lines that belong to it.
 */
function removeCard(boardText: string, id: string): string {
  const lines = boardText.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] ?? "";
    const card = parseCardLine(l);
    if (card && card.id === id) {
      i++;
      while (i < lines.length && isContinuation(lines[i] ?? "")) {
        i++;
      }
    } else {
      out.push(l);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Add a card under the given column header. The card may be multi-line
 * (head + indented sub-bullets). Inserts the whole block as one unit at
 * the end of the column, with a trailing blank line before the next
 * column / settings block.
 */
function addCard(boardText: string, column: string, cardLine: string): string {
  const lines = boardText.split("\n");
  const cols = indexColumns(lines);
  const target = cols.find((c) => c.name === column);
  if (!target) {
    throw new Error(`board.md is missing the "${column}" column`);
  }

  // Walk the column. After each card head, skip its continuation lines.
  // insertAt lands right after the last card's continuation block.
  let insertAt = target.headerLine + 1;
  for (let i = target.headerLine + 1; i < target.nextHeaderLine; i++) {
    if (parseCardLine(lines[i] ?? "")) {
      let j = i + 1;
      while (j < target.nextHeaderLine && isContinuation(lines[j] ?? "")) {
        j++;
      }
      insertAt = j;
      i = j - 1;
    }
  }

  // Skip the single blank line after the header on an otherwise-empty column.
  if (insertAt === target.headerLine + 1 && (lines[insertAt] ?? "").trim() === "") {
    insertAt += 1;
  }

  // The kanban-plugin renderer needs a blank line between this card's last
  // line and whatever follows (next column header / %% settings block). If
  // the line at insertAt is already blank, reuse it.
  const next = lines[insertAt] ?? "";
  const needsTrailingBlank = next.trim() !== "";
  const cardLines = cardLine.split("\n");
  const inserted = needsTrailingBlank ? [...cardLines, ""] : cardLines;

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, ...inserted, ...after].join("\n");
}

/**
 * Idempotent upsert: ensures exactly one card with this id exists, in the
 * given column, with the given (possibly multi-line) content. If the card
 * was elsewhere it's removed and re-added.
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
