---
name: team-tracking-obsidian-kanban
description: Use when your project's team-tracking adapter is `obsidian-kanban` and you need to understand the file layout, card-eligibility rule, default-status rule, sub-bullet rendering, or auto-flip behavior. Reference for surprises that don't show up in `team-tracking-usage` because they're adapter-specific. Skip when using Jira.
---

# team-tracking-obsidian-kanban

Reference for the **obsidian-kanban** adapter — the one that backs your tracker with markdown files in an Obsidian vault. Most users encounter the surprises documented here when they first wonder *"why isn't this card on the board?"* or *"why didn't the parent flip to Done?"*.

If your project uses Jira: skip this skill. The conformance contracts are the same; the adapter mechanics aren't.

## File layout

```
<vault>/
  projects/<Project>/
    board.md                      # the kanban view (Obsidian Kanban plugin)
    architecture.md               # scaffolded; you fill it in
    tickets/
      <slug-1>/
        ticket.md                 # frontmatter + body + ## Children + log/messages/events
        children/
          <child-slug-1>/
            ticket.md
            children/
              <grandchild-slug-1>/
                ticket.md
```

Path-id of a ticket is its directory path under `projects/<Project>/`, e.g. `tickets/auth/children/login-flow`. Wiki-links use vault-relative paths anchored at `projects/<Project>/` to disambiguate sibling slugs across projects.

## Default status on creation

```
type === "subtask"  → status defaults to "Todo"
otherwise            → status defaults to "Backlog"
```

Subtasks are leaves and start ready-to-pick-up. Non-leaves start in `Backlog` and must be **promoted to `Todo`** before they're considered planned (see `team-tracking-plan`'s "Column lifecycle"). The promotion is the orchestrator's responsibility.

## Card-eligibility rule

A ticket has its **own card** on `board.md` iff:

1. its `type !== "subtask"` (i.e. it's a non-leaf), AND
2. it's top-level (`parent === null`) **OR** its parent's status has advanced past `Backlog`.

Subtasks (leaves) **never** get their own card — they're decomposition artifacts, surfaced only as checklist sub-bullets inside their parent task's card.

### What this means in practice

| State | Renders as |
|---|---|
| Top-level epic / story / task (any column) | Its own card |
| Non-leaf child whose parent is still in `Backlog` | Sub-bullet inside the parent's card. **No own card.** |
| Non-leaf child whose parent is past `Backlog` | Both: own card on the board *and* a sub-bullet inside the parent's card |
| Subtask (any state) | Sub-bullet inside the parent task's card. **No own card.** Not on the board. |

### Hoisting trigger

When a parent transitions `Backlog → (anything else)`, the adapter walks its non-leaf children and places each one as its own card. That's the moment children become independently trackable on the board. New non-leaves created under a non-`Backlog` parent are placed immediately on creation.

If you later roll the parent back to `Backlog`, the hoisted children's cards are removed (they fall back to sub-bullet-only). This is rare in practice — `Backlog` is a starting state, not something you usually return to — but it's the symmetric behavior.

### Why subtasks aren't on the board

A subtask is a step in a pipeline (write tests → implement → review). The pipeline lives inside its parent task. Surfacing each subtask as a top-level card on the board would clutter the columns with workflow steps that aren't independently meaningful — the "feature" being shipped is the parent task. The subtasks roll up into that.

If you want to **see** subtasks as you supervise: open the parent task's card on the board (sub-bullets), or open the parent's `ticket.md` (full `## Children` list with wiki-links).

## Auto-flip parent on all-children-Done

When every immediate child of a non-leaf is `Done`, the adapter flips the parent to `Done` automatically. The flip propagates up: a task auto-Dones when its subtasks are all Done; the epic auto-Dones when its tasks are all Done.

```
subtask Done ─► task auto-Done (if all subtasks Done)
                                      │
                                      ▼
                              epic auto-Done (if all tasks Done)
```

A non-leaf with **zero children** does **not** auto-flip. (A freshly-created leafless ticket isn't trivially Done.)

**Don't manually set a parent to `Done`.** Set the leaf to `Done` and let the rollup do its job. Manual sets diverge from rollup state and confuse future readers of the audit log.

## `## Children` is auto-rendered — don't hand-edit

Each `ticket.md` ends with a `## Children` section listing its immediate children as wiki-links with checkbox state:

```markdown
## Children

- [x] [[projects/P/tickets/foo/children/done-thing/ticket|done-thing]]
- [ ] [[projects/P/tickets/foo/children/pending/ticket|pending]]
```

The adapter regenerates this section on every mutation that affects children. **Edits you make by hand will be overwritten on the next adapter write.** If you need to express something about children that the adapter doesn't, put it in the body above `## Children`, not in the section itself.

`board.md` follows the same rule: it's authored by the adapter. Hand-edits survive only if you don't touch any structural element (cards, columns, sub-bullets). Safe edits: column reorder, kanban settings tweaks. Unsafe: changing card text, moving cards manually (use `update_ticket` instead).

## Files vs API: who sees what

| Surface | What's there | Who consumes it |
|---|---|---|
| `board.md` | Top-level cards + non-leaf hoisted cards. Each card lists its immediate children as sub-bullets. | Obsidian (visual kanban); `list_board` (returns the same set as a structured list). |
| `ticket.md`'s `## Children` | The ticket's *immediate* children only. | Obsidian (rendered as a clickable list); `get_ticket` (returns child refs). |
| `ticket.md`'s body | Free-form markdown — spec, plan, RCA, notes. | Both Obsidian and the API. |
| `ticket.md`'s log / messages / events | Append-only blocks managed by the adapter. | `read_messages`, `read_events`, `append_log`. |

So if a subtask exists but you don't see it on the board: that's the contract, not a bug. Open the parent task to see it.

## Common surprises (and what they actually are)

| Symptom | Reality |
|---|---|
| "I created an epic and two tasks, the tasks aren't on the board" | The epic is in `Backlog`; promote it to `Todo` and the tasks get hoisted. |
| "I set the epic's status to `Todo` but the children are still in `Backlog`" | That's correct. Hoisting moves children onto the board, not into a different column. The children's *own* status doesn't change. |
| "All my subtasks are `Done` but the task is still `Todo`" | Auto-flip checks every immediate child. If you missed one (or have a sibling task without children), the parent stays put. `get_ticket(parentRef)` and inspect its `children`. |
| "I edited `## Children` and it disappeared on the next save" | Don't. The adapter rewrites it. |
| "I see a card on the board but `list_board` doesn't return it" | Likely the ticket file was deleted or its frontmatter is malformed. Run `get_ticket(ref)` — if it returns null, the file is gone but the card line wasn't cleaned up. Re-create or delete the orphan card. |
