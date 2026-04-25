---
name: team-tracking-orchestrate
description: Use when you are the orchestrator turning a goal/PRD into board state — reading the existing board, deciding hierarchy and priority, decomposing tasks into pipeline subtasks, consulting the architect, and handing off to specialists. Covers what to put on the board and in what order.
---

# team-tracking-orchestrate

You're the planner. You read the board, decide structure, and dispatch — you don't write code or hold locks. Pairs with [`harness-orchestrate`](https://) (which says how to dispatch task teams) and the lower-level [`team-tracking-usage`](../team-tracking-usage/SKILL.md) reference.

## Step 0 — read the board first

```
list_board(project)
```

The response is priority-ordered (`In Progress` → `Todo` → `Backlog`). Don't plan in a vacuum:

- `lock_state == "in_progress"` — a specialist is actively working. Don't create overlapping work.
- `lock_state == "committed"` — work is in flight with a checkpoint. If `lock.acquired_at` is past TTL, it's a crash; surface to the user before stealing the lock.
- `scope` — free-text conflict signal. If your new ticket touches the same module, sequence behind (or split that module out first).
- `branch` — code is already moving. Coordinate, don't duplicate.

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
1. `architecture.md` inside the project's vault folder (the Obsidian adapter scaffolds this).
2. `ARCHITECTURE.md` / `CLAUDE.md` at the repo root.
3. The project's design doc.
4. If none of the above, surface the ambiguity to the user before dispatching anything.

## Dispatching

You don't acquire locks. The specialist does. Your handoff is:

1. Pick the specialist (implementer, test-writer, adversarial-test-reviewer, adversarial-code-reviewer, …)
2. Pass them the subtask's `TicketRef` and a short prompt describing what "done" looks like
3. They run [`team-tracking-execute`](../team-tracking-execute/SKILL.md) — acquire → checkpoint → release
4. When they release as `Blocked`, read the ticket's `update` + `progress_summary` and decide: split further, reassign, or escalate to user/architect

## Polling for progress

```
list_board(project)
```

Re-read between dispatches. Look for:
- `Blocked` tickets — read `progress_summary` and act
- Stale `committed` locks (past TTL with the same checkpoint for too long) — likely crashed; offer to recover

## Red flags

- **Don't create a task without subtasks.** A bare task is half-done planning.
- **Don't acquire locks.** That's the specialist's job.
- **Don't promote `Todo` → `In Progress` yourself.** It happens automatically when a specialist acquires the lock.
- **Don't reuse `scope` strings inconsistently.** Pick a vocabulary (typically module/package names) and stick to it.
- **Don't dispatch a task whose subtasks contradict each other.** Re-read the spec when in doubt.
