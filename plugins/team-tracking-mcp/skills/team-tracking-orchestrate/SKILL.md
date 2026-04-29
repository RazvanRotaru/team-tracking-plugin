---
name: team-tracking-orchestrate
description: Use when you are the orchestrator on a team-tracking project. Routes to the role-specific skill — `team-tracking-plan` (decomposing intent into board state, dispatching specialists) or `team-tracking-supervise` (keeping in-flight specialists on track via the event log and steering channel).
---

# team-tracking-orchestrate

Orchestration has two modes — **plan** (decide what goes on the board, decompose, dispatch) and **supervise** (keep dispatched specialists on track). Each is its own skill. This entry exists for back-compat and to route you to the right one.

## Pick by where you are

| Where you are | Skill |
|---|---|
| Turning a goal/PRD/bug into board state. Reading the existing board. Choosing hierarchy + priority. Decomposing a task into pipeline subtasks. Promoting parents to `Todo`. Briefing specialists for dispatch. | [`team-tracking-plan`](../team-tracking-plan/SKILL.md) |
| At least one specialist is in flight. Listening on the event log. Reading checkpoints. Posting nudges/questions. Recovering stale locks. Acting on `Blocked` / `Done` events. | [`team-tracking-supervise`](../team-tracking-supervise/SKILL.md) |

## The two phases interleave

In a real session you alternate: plan → dispatch → supervise → a specialist releases as `Done` → plan the next pipeline stage → dispatch → supervise. Don't try to keep both protocols loaded at once; switch as you cross phases.

## Other skills you'll reach for

- [`team-tracking-execute`](../team-tracking-execute/SKILL.md) — the protocol the **specialist** runs. Read it once so you know what they're doing on the other side of the dispatch.
- [`team-tracking-usage`](../team-tracking-usage/SKILL.md) — tool reference: the eleven MCP tools, the four ticket types, the unified event log, the lock state machine.
- [`team-tracking-obsidian-kanban`](../team-tracking-obsidian-kanban/SKILL.md) — adapter quirks if your project uses the obsidian-kanban backend (file layout, card-eligibility rule, sub-bullet rendering, do-not-edit `## Children`).
