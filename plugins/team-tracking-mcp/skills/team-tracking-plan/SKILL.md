---
name: team-tracking-plan
description: Use when turning a goal/PRD into board state — reading the existing board, choosing hierarchy + priority, decomposing tasks into pipeline subtasks, and handing off to specialists. Covers what to put on the board and in what order. Pairs with `team-tracking-supervise` (after the dispatch).
---

# team-tracking-plan

You're the planner. You turn intent into structure: read the existing board, decide hierarchy, decompose, dispatch. You **don't** write code, **don't** acquire locks, and **don't** stay in the loop after dispatch — supervision is a separate skill ([`team-tracking-supervise`](../team-tracking-supervise/SKILL.md)).

> This skill is loaded by the [`team-tracking-planner`](../../agents/team-tracking-planner.md) subagent. If you're in a main session and considering loading it directly, prefer spawning the agent instead — it owns this protocol and returns a structured `dispatch_list`, keeping board-reading and decomposition out of your context.

Lower-level tool reference: [`team-tracking-usage`](../team-tracking-usage/SKILL.md).

## Step 0 — read the board first

```
list_board(project)
```

The response is priority-ordered (`In Progress` → `Todo` → `Backlog`). Don't plan in a vacuum:

- `lock_state == "in_progress"` — a specialist is actively working. Don't create overlapping work.
- `lock_state == "committed"` — work is in flight with a checkpoint. If `lock.acquired_at` is past TTL, it's a crash; surface to the user before stealing the lock.
- `scope` — free-text conflict signal. If your new ticket touches the same module, sequence behind (or split that module out first).
- `branch` — code is already moving. Coordinate, don't duplicate.

## Column lifecycle

The board has five columns; the meaningful state machine is:

```
Backlog ──plan──► Todo ──lock acquired──► In Progress ──PR opened──► In Review ──merged──► Done
                                                                                              ▲
                          ┌───── auto-flip when every child is Done ──────────────────────────┘
```

- **Backlog** — Created. Not yet committed to plan. No subtasks attached.
- **Todo** — *Committed to plan.* You decomposed the ticket into pipeline subtasks and are about to dispatch. **You move it here yourself, before adding subtasks.** This is the cue the obsidian-kanban adapter uses to hoist non-leaf children onto the board as their own cards (so each child can be tracked through the columns independently).
- **In Progress** — Auto. Set when the first specialist `acquire_ticket`s — don't write it manually.
- **In Review** — Manual on the leaf. Specialist transitions their own subtask via `release_ticket(..., final_status: "In Review")` once the PR is open.
- **Done** — Manual on the leaf, auto on the parent. Specialist sets their subtask to Done at merge. The adapter flips the parent (task) when all its subtasks are Done; the epic flips when all its tasks are Done; etc.

**The Backlog → Todo move is yours to make.** A common mistake (it bit a real session): create tickets, attach subtasks, dispatch, and never promote the parent — the board ends up with everything still in Backlog because nothing downstream promotes it. Nothing does.

```
update_ticket(epicRef,  { status: "Todo" })   // before adding child tasks
update_ticket(taskARef, { status: "Todo" })   // before adding child subtasks
update_ticket(taskBRef, { status: "Todo" })   // ditto
```

## Hierarchy

PRD shape → top-level type. The server enforces these parent rules.

| PRD shape | Top-level | Decompose into |
|---|---|---|
| Multi-slice feature | `epic` | stories |
| Single feature | `story` | tasks |
| One-off change | `task` | pipeline subtasks |

```
epic    parent: null
story   parent: epic | null
task    parent: story | epic | null
subtask parent: task | story
```

## Tasks **must** be decomposed

A task without subtasks is incomplete planning. Every task gets pipeline subtasks before dispatch.

| Stage | Required? | When to skip |
|---|---|---|
| Write tests | Optional (TDD opt-in) | Truly throwaway / unverifiable changes |
| Adversarial test review | Optional (only with tests) | Trivial test surfaces |
| **Implement** | **Required** | — |
| Spec compliance review | Optional | Self-contained UI tweaks where the spec is a Figma file |
| **Adversarial code review** | **Required (≥1)** | — |

Pick **more** stages (and multiple reviewers) for: auth, billing, migrations, public API changes, anything cross-cutting. Pick **fewer** for: self-contained UI, plumbing inside an existing pattern, spikes (often `investigate → write findings → peer review`).

## Priority

| | When |
|---|---|
| `P0` | Regression, data loss risk, security, or blocks the release |
| `P1` | On the critical path for the next sprint |
| `P2` | Default. Want-not-need: cleanup, polish, deferred |

Don't promote unless the constraint is real. Priority isn't a signaling tool — `lock_state` already tells specialists what's hot.

## Architect consultation

Consult an architect (human or skill) **before dispatching** when:

- The change spans modules you haven't worked in — ask "is the seam right?"
- The PRD leaves the impl shape ambiguous — get a decision before locking in subtasks
- A pipeline subtask threatens to grow beyond one specialist session

Where to look for architectural context, in order:
1. `architecture.md` inside the project's vault folder (the obsidian-kanban adapter scaffolds this).
2. `ARCHITECTURE.md` / `CLAUDE.md` at the repo root.
3. The project's design doc.
4. If none of the above, surface the ambiguity to the user before dispatching anything.

## Dispatching

You don't acquire locks. The specialist does. Your handoff is:

1. Promote the parent to **Todo** (see "Column lifecycle"). Skipping this step is a common mistake.
2. Pick the specialist role for the subtask (implementer, test-writer, adversarial-test-reviewer, adversarial-code-reviewer, …).
3. Hand them the subtask's `TicketRef` plus a short brief: what "done" looks like, files in scope, links to spec, the parent task's body for context.
4. They run [`team-tracking-execute`](../team-tracking-execute/SKILL.md) — acquire → checkpoint → release. Acquiring the lock auto-flips the subtask to `In Progress`.
5. After dispatching, switch to [`team-tracking-supervise`](../team-tracking-supervise/SKILL.md) for the supervision protocol.
6. When a specialist releases as `Blocked`, read the ticket's `update` + `progress_summary` and decide: split further, reassign, or escalate to user/architect.

**How** you actually summon the specialist is host-specific — Claude Code's `Agent` tool, an external worker queue, a sub-agent CLI, an issue assignee in your tracker. This skill is agnostic to that mechanism. The only contract is: the specialist receives `TicketRef`, runs `team-tracking-execute`, and reports back via the events log.

## `update_ticket` — when and how

`update_ticket` is the only tool that mutates a ticket's mutable fields outside the lock contract (status, priority, scope, branch, pr_url, labels, body, title). Use it when you need to:

### Promote a parent to `Todo` before dispatch

```
update_ticket(parentRef, { status: "Todo" })
```

Triggers card hoisting in the obsidian-kanban adapter. Every non-leaf child becomes its own card on the board.

### Tag a ticket's scope after the first commit

When the implementer's branch is open and you can see the conflict surface, lock in the `scope` so future planners avoid double-booking the same module:

```
update_ticket(taskRef, { scope: "auth/middleware" })
```

### Wire `branch` and `pr_url` for visibility

The specialist sets these as part of their normal flow, but if the orchestrator notices a missing wire-up (e.g. the specialist forgot, or you're stitching together a hand-off across sessions):

```
update_ticket(taskRef, {
  branch: "feat/auth-retry-policy",
  pr_url: "https://github.com/org/repo/pull/123",
})
```

### Re-prioritize when constraints change

Promote a P2 to P1 when it lands on the critical path — but only if the underlying constraint actually changed. Priority is a routing signal, not a nag.

```
update_ticket(taskRef, { priority: "P1" })
```

### Edit a ticket body to encode a refined plan

When supervision uncovers a sharper decomposition or a missing acceptance criterion, edit the body. Keep edits surgical — a long body that's been rewritten multiple times reads as confused planning.

```
update_ticket(taskRef, {
  body: "## Updated plan after blocker on retry\n\n…",
})
```

### What `update_ticket` is **not** for

- **Don't write `status: "In Progress"` yourself.** That's auto on lock acquire.
- **Don't write `status: "Done"` on a parent task.** Auto-flip handles it; manual sets diverge from rollup state.
- **Don't poke a ticket with a live lock** — the holding specialist may rely on the fields you're about to overwrite.
- **Don't use `update_ticket` to record progress.** Use `report_progress` (no lock needed) or `commit_checkpoint` (lock + SHA) — both flow through the event log so the supervisor sees them.

## Conventions vs project deviations

The rules in this skill (column meanings, decomposition pipeline, priority semantics) are the **canonical defaults**. They're meant to be portable across projects. If your team or project deviates — different column names, an extra `Staging` column, skipping `In Review`, custom subtask roles — the right place for that knowledge is **not** another copy of these rules in your user-memory or somewhere else that future agents won't find.

The right places, in priority:

1. **Project `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`** at the repo root or the relevant subdirectory. Per-project adaptations live with the project. Future agents loading the project will see them.
2. **The skill itself** if the deviation is actually an improvement that everyone should adopt — submit it back upstream.
3. **User-memory** as a last resort, for personal-preference overrides ("I always use P1 even for P2 work because my manager reads the board").

If you find yourself encoding a workflow rule in user-memory because "the skill doesn't say it," either the skill should say it (PR upstream) or your project deviates from canon (CLAUDE.md). User-memory is the wrong substrate for shared workflow conventions — it doesn't follow the project, doesn't help your colleagues, and doesn't help next month's session in another project.

## Red flags

- **Don't create a task without subtasks.** A bare task is half-done planning.
- **Don't acquire locks.** That's the specialist's job.
- **Don't promote `Todo` → `In Progress` yourself.** It happens automatically when a specialist acquires the lock.
- **Don't forget `Backlog` → `Todo`.** That promotion *is* yours — it's the signal that you've decomposed the ticket and the children are ready to be picked up. Forgetting it leaves the whole tree marooned in Backlog.
- **Don't manually set a parent to `Done`.** Set the leaf subtask to `Done`; the adapter rolls the parent up when every sibling is also Done. Manual sets diverge from rollup state.
- **Don't reuse `scope` strings inconsistently.** Pick a vocabulary (typically module/package names) and stick to it.
- **Don't dispatch a task whose subtasks contradict each other.** Re-read the spec when in doubt.
