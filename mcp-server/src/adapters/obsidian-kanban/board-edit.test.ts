import { describe, expect, it } from "vitest";
import { formatCard, initialBoardText, listBoardCards, upsertCard } from "./board-edit.js";

describe("board-edit", () => {
  const card = (id: string) =>
    formatCard({ id, slug: id.split("/").pop() ?? id, priority: "P1", type: "task", done: false });

  it("inserts a blank line between the card and the next column header", () => {
    const board = initialBoardText();
    const next = upsertCard(board, {
      id: "tickets/foo",
      column: "Todo",
      cardLine: card("tickets/foo"),
    });
    // The relevant slice should look like:
    //   ## Todo\n\n- [ ] [[...]]\n\n## In Progress
    expect(next).toMatch(/## Todo\n\n- \[ \] \[\[tickets\/foo\/ticket\|foo\]\][^\n]*\n\n## In Progress/);
  });

  it("inserts a blank line between the card and the kanban settings block (last column)", () => {
    const board = initialBoardText();
    const next = upsertCard(board, {
      id: "tickets/done-x",
      column: "Done",
      cardLine: card("tickets/done-x"),
    });
    expect(next).toMatch(/## Done\n\n- \[ \] [^\n]*\n\n%% kanban:settings/);
  });

  it("does not double-insert blanks when adding a second card to the same column", () => {
    let board = initialBoardText();
    board = upsertCard(board, {
      id: "tickets/a",
      column: "Todo",
      cardLine: card("tickets/a"),
    });
    board = upsertCard(board, {
      id: "tickets/b",
      column: "Todo",
      cardLine: card("tickets/b"),
    });
    // Two cards back-to-back, then one blank, then next header.
    expect(board).toMatch(
      /## Todo\n\n- \[ \] [^\n]*tickets\/a[^\n]*\n- \[ \] [^\n]*tickets\/b[^\n]*\n\n## In Progress/,
    );
  });

  it("upsert moves a card between columns", () => {
    let board = initialBoardText();
    board = upsertCard(board, {
      id: "tickets/x",
      column: "Backlog",
      cardLine: card("tickets/x"),
    });
    board = upsertCard(board, {
      id: "tickets/x",
      column: "In Progress",
      cardLine: card("tickets/x"),
    });
    const cards = listBoardCards(board);
    const x = cards.filter((c) => c.id === "tickets/x");
    expect(x).toHaveLength(1);
    expect(x[0]?.column).toBe("In Progress");
  });
});
