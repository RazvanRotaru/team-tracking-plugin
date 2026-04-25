---
name: team-tracking-usage
description: How to use the team-tracking MCP server to read and mutate tracked work (epics, stories, tasks, subtasks). Use this skill when an orchestrator needs to dispatch implementation work, when a specialist subagent needs to report progress mid-run, or when retrying a crashed run.
---

# team-tracking-usage

A Claude Code orchestrator and its specialist subagents use these MCP tools (server name: `team-tracking`) to coordinate work. The tracker (Jira or Obsidian Kanban) is the only source of truth — there is no side-store and the orchestrator never reads markdown or JSON to reason about state, only the tools below.

## Ticket model

Four types, in a strict hierarchy:

```
epic → story → task → subtask
```

A `subtask` is the atomic unit a specialist owns. Allowed parents:

| Type | Allowed parent |
|---|---|
| `epic` | (none) |
| `story` | `epic` or none |
| `task` | `story`, `epic`, or none |
| `subtask` | `task` or `story` |

PRD complexity → top-level type:

| PRD shape | Top-level type |
|---|---|
| Multi-slice feature | `epic` |
| Single feature | `story` |
| One-off change | `task` |

## Reads

- `list_board(project)` — top-level tickets in priority order: `In Progress` → `Todo` → `Backlog`. Excludes `In Review` and `Done`. Use this to plan dispatch order.
- `get_ticket(ref)` — full ticket including `body`, `lock`, `lock_state`, `update`, `progress_summary`, `children`.
- `list_children(ref)` — immediate children resolved as full DTOs.

## Orchestrator writes

- `create_ticket(project, draft)` — server enforces parent-type rules. The orchestrator chooses the top-level type (epic/story/task) based on PRD complexity, never inferred.
- `update_ticket(ref, update)` — patch `title`, `body`, `status`, `priority`, `labels`, `scope`, `branch`, `pr_url`. Cannot change `type` or `parent`.

## Specialist (lock-bound) writes

Every subtask handoff to a specialist follows: **acquire → (commit_checkpoint × N) → release.**

- `acquire_ticket(ref, owner)` → `{ lock_token, recovered_checkpoint }`
  - Returns a fresh `lock_token`. Subsequent specialist calls must include this token.
  - `recovered_checkpoint` is non-null when the previous holder timed out; it carries the last good `commit_id` so the orchestrator can `git reset --hard` before retrying.
- `commit_checkpoint(ref, { lock_token, commit_id, update?, progress_summary? })`
  - Call **after** creating a real git commit. The server records the SHA without verifying it.
  - Updates the visible `update` and `progress_summary` fields.
- `release_ticket(ref, { lock_token, final_status })`
  - Typical `final_status`: `Done` (work complete) or `Blocked` (needs human).

Between commits, two more tools are available:

- `report_progress(ref, { lock_token, status?, update?, progress_summary? })` — pulse update without recording a SHA.
- `append_log(ref, line)` — append-only audit. **Not** gated on a lock; anyone may log.

## Retry-from-checkpoint contract

When a subagent crashes mid-run:

1. The lock persists on the ticket until its TTL elapses (default 30 minutes).
2. The orchestrator scans the board; sees `lock_state: "committed"` on a stale lock.
3. The orchestrator calls `acquire_ticket` and receives `recovered_checkpoint` (because the prior holder is past TTL).
4. The orchestrator runs `git checkout <branch> && git reset --hard <recovered_checkpoint.commit_id>` in the workspace.
5. The orchestrator dispatches a retry, prompting the new subagent with the recovered `progress_summary` and `update` for context.
6. The new specialist holds a fresh token; its checkpoints overwrite cleanly.

If the prior `lock_state` was `in_progress` (acquired but never checkpointed), there is no safe SHA to reset to. Treat as a full retry from the branch base.

## Errors

Tool calls return `{ isError: true, content: [{ text: "EXXX: <message>" }] }` for invariant violations. Common codes:

- `EPARENT` — parent type is incompatible with child type, or a required parent is missing.
- `ETYPE_IMMUTABLE` — `type` or `parent` cannot be changed after creation.
- `ESTATUS` — status not allowed for the type. Defaults: epic/story/task ∈ {Backlog, Todo, In Progress, In Review, Done}; subtask ∈ {Todo, In Progress, Blocked, Done}.
- `ELOCKED` — a live (non-stale) lock is held by someone else.
- `EBADTOKEN` — the supplied `lock_token` does not match the live lock.
- `ENOTLOCKED` — operation requires a lock but none is held.
- `ENOTFOUND` — ticket ref does not exist.
- `ENOTCONFIGURED` — `./.team-tracking/config.json` missing.

## Conventions

- `lock_state` is derived: `free` (no lock), `in_progress` (lock held, no checkpoint), `committed` (lock held with at least one checkpoint). It is orthogonal to `status`.
- The orchestrator should write `branch` and `pr_url` on the ticket as soon as either is created — they are the link between board state and code state.
- `scope` is free-text (e.g. `"auth module"`). The orchestrator reads it to detect potential conflict between concurrent specialists; the server does not pattern-match.

## Task decomposition norm (harness-orchestrate / harness-task-team)

**A task must always be decomposed into subtasks before it's handed off.** The orchestrator owns the task's structure; specialists own subtasks. A bare task with no subtasks is incomplete planning.

Each subtask represents one stage of the harness-task-team pipeline. The orchestrator picks which stages apply to a given task; a small change might be `implement → code-review`, a load-bearing change `write-tests → adversarial-test-review → implement → spec-compliance-review → adversarial-code-review` (with a second adversarial reviewer if the surface warrants it).

| Stage | Required? | What the subtask represents |
|---|---|---|
| `Write tests` | Optional (TDD opt-in) | Failing tests authored by a test-writer subagent |
| `Adversarial test review` | Optional (only meaningful with tests) | Tests attacked for gaps before implementation starts |
| `Implement` | **Required** | The implementer subagent's actual code change |
| `Spec compliance review` | Optional | Spec-reviewer subagent verifies the impl matches the spec |
| `Adversarial code review` | **Required** (≥1) | Reviewer attacks impl for bugs / missing cases. Multiple reviewers allowed (e.g. security + architecture). |

### Lock placement

Locks belong on the **specific subtask a specialist is currently executing**, never on the parent task. The implementer holds the lock while implementing; reviewers acquire fresh locks on review subtasks. A task's `status` is the orchestrator's aggregate view of its subtasks — it isn't itself locked.

### Sequencing

Stages are ordered. The orchestrator should not dispatch a downstream stage until the upstream stage's subtask is `Done`. Example: don't dispatch the implementer until `Adversarial test review` is `Done` (when TDD applies). Adversarial review failure → loop back to the upstream stage's subtask (re-dispatch test writer or implementer).

### Retry semantics inside a pipeline

If an adversarial review surfaces gaps, the upstream subtask's status flips back from `Done` to `In Progress` (or `Blocked`) and is re-dispatched. The lock+checkpoint flow is unchanged — a fresh acquire on the upstream subtask gets a new token; previous checkpoints on it still surface as `recovered_checkpoint` if the prior session was abandoned.
