---
name: team-tracking-orchestrate
description: Use when you are the orchestrator on a team-tracking project. Routes to the role-specific skill — `team-tracking-plan` (decomposing intent into board state, dispatching specialists) or `team-tracking-supervise` (keeping in-flight specialists on track via the event log and steering channel).
---

# team-tracking-orchestrate

Orchestration has two modes — **plan** (decide what goes on the board, decompose, dispatch) and **supervise** (keep dispatched specialists on track). Each is its own skill. This entry exists for back-compat and to route you to the right one.

## Pick by where you are

| Where you are | What to do |
|---|---|
| Turning a goal/PRD/bug into board state. Reading the existing board. Choosing hierarchy + priority. Decomposing a task into pipeline subtasks. Promoting parents to `Todo`. Briefing specialists for dispatch. | **Spawn the [`team-tracking-planner`](../../agents/team-tracking-planner.md) subagent.** Hand it the PRD/intent and the project name; it returns a structured `dispatch_list`. Keeps board reading and decomposition out of your context. |
| At least one specialist is in flight. Listening on the event log. Reading checkpoints. Posting nudges/questions. Recovering stale locks. Acting on `Blocked` / `Done` events. | Load [`team-tracking-supervise`](../team-tracking-supervise/SKILL.md). |

## The two phases interleave

In a real session you alternate: spawn the planner → dispatch what it returned → supervise → a specialist releases as `Done` or `Blocked` → spawn the planner again for the next pipeline stage (or to re-plan around the blocker) → dispatch → supervise. Planning lives in the subagent; supervision lives in your session.

## Other skills you'll reach for

- [`team-tracking-planner`](../../agents/team-tracking-planner.md) — the subagent you spawn for every plan / re-plan. Owns `team-tracking-plan` internally so you don't have to load it.
- [`team-tracking-execute`](../team-tracking-execute/SKILL.md) — the protocol the **specialist** runs. Read it once so you know what they're doing on the other side of the dispatch.
- [`team-tracking-usage`](../team-tracking-usage/SKILL.md) — tool reference: the eleven MCP tools, the four ticket types, the unified event log, the lock state machine.
- [`team-tracking-obsidian-kanban`](../team-tracking-obsidian-kanban/SKILL.md) — adapter quirks if your project uses the obsidian-kanban backend (file layout, card-eligibility rule, sub-bullet rendering, do-not-edit `## Children`).
