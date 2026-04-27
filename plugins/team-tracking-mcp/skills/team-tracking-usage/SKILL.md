---
name: team-tracking-usage
description: Reference for the team-tracking MCP server — the eleven tools, the four ticket types, the unified event log, the lock state machine, and the typed errors. Load this when you need to know what a tool does or how `lock_state` is derived. For role-specific protocols, use `team-tracking-orchestrate` (planner) or `team-tracking-execute` (specialist).
---

# team-tracking-usage

Tool reference for the team-tracking MCP server (server name: `team-tracking`). The tracker (Jira or Obsidian Kanban) is the only source of truth — there's no side-store, and no caller should parse markdown or JSON to reason about state. Use the tools below.

For *what to do with these tools by role*, see:
- [`team-tracking-orchestrate`](../team-tracking-orchestrate/SKILL.md) — planning, decomposition, dispatch
- [`team-tracking-execute`](../team-tracking-execute/SKILL.md) — running a single subtask, escalation

## Ticket model

Four types in a strict hierarchy:

```
epic → story → task → subtask
```

Server-enforced parent rules:

| Type | Allowed parent |
|---|---|
| `epic` | `null` |
| `story` | `epic` or `null` |
| `task` | `story`, `epic`, or `null` |
| `subtask` | `task` or `story` |

Subtasks are the atomic unit a specialist owns. A task without subtasks is incomplete planning (see `team-tracking-orchestrate`).

## The unified event log

Every state change on a ticket is recorded as an append-only `Event` on that ticket. The log is the audit-canonical surface; the scalar fields exposed by `get_ticket` (`update`, `progress_summary`, `lock`) are read caches that mirror the latest relevant event.

| Event type | Emitted when |
|---|---|
| `message` | `post_message` (steering channel — nudges, questions, responses, acks) |
| `checkpoint` | `commit_checkpoint` |
| `progress` | `report_progress` |
| `log` | `append_log` |
| `status_change` | Any tool call that changes `status` |
| `lock_change` | `acquire_ticket` (action: `acquire` or `recover`), `release_ticket` (action: `release`) |

Events are ordered by their server-minted `at` timestamp. The cursor for incremental reads is `since` — string compare on ISO-8601 is monotonic, so `at > since` is well-defined.

## The eleven tools

### Reads
- `list_board(project)` — top-level tickets in priority order: `In Progress` → `Todo` → `Backlog`. Excludes `In Review` and `Done`.
- `get_ticket(ref)` — full ticket: body, lock, lock_state, update, progress_summary, children. Reads from the cache fields; for the full audit history use `read_events`.
- `list_children(ref)` — immediate children resolved as full DTOs.
- `read_events(ref, { since?, types? })` — the unified event log. Pass `since` to advance a stateless cursor. Pass `types` (e.g. `["message"]`) to filter.
- `read_messages(ref, since?)` — convenience projection equivalent to `read_events(ref, { since, types: ["message"] })` shaped as `Message[]`.

### Orchestrator writes
- `create_ticket(project, draft)` — server enforces parent-type rules. The caller chooses the top-level type based on PRD complexity, never inferred.
- `update_ticket(ref, update)` — patch `title`, `body`, `status`, `priority`, `labels`, `scope`, `branch`, `pr_url`. Cannot change `type` or `parent` after creation. A `status` change emits a `status_change` event.

### Lock-bound writes (specialist)
Every subtask handoff follows: **acquire → (commit_checkpoint × N) → release.** Each call records one or more events.

- `acquire_ticket(ref, owner)` → `{ lock_token, recovered_checkpoint }`
  - Mints a fresh token. Subsequent calls must include it.
  - `recovered_checkpoint` is non-null when the previous holder timed out (TTL-stale lock); it carries the last good `commit_id`.
  - Emits `lock_change` (action: `acquire` or `recover`) plus a `status_change` if Todo → In Progress.
- `commit_checkpoint(ref, { lock_token, commit_id, update?, progress_summary? })`
  - Call **after** making the actual git commit. Records a `checkpoint` event.
- `release_ticket(ref, { lock_token, final_status })`
  - Emits `lock_change` (action: `release`) plus a `status_change` if `final_status` differs from the current status.

Between commits:
- `report_progress(ref, { lock_token, status?, update?, progress_summary? })` — pulse update without recording a SHA. Emits a `progress` event (and a `status_change` when `status` is provided and differs).

Audit trail (no lock required):
- `append_log(ref, line)` — append-only. Anyone may log. Emits a `log` event.

### Steering channel (no lock required)

Bidirectional, async, plugin-agnostic messaging on the ticket itself. Used by `team-tracking-orchestrate` to nudge specialists in flight, and by `team-tracking-execute` to ACK / answer / push back.

- `post_message(ref, { from, kind?, body, in_reply_to? })` → `Message` (server mints `id` and `at`). Emits a `message` event.

Conventional `kind` values: `nudge`, `question`, `response`, `ack`, `info`. Free-text — the server does not enforce.

### Real-time delivery: the listen CLI

Polling `read_events` / `read_messages` works but burns cycles. Use the listen CLI as a **background bash process** for push-style delivery:

```
team-tracking listen --project <p> [--ticket-id <id>] [--since <iso>] \
                     [--types message,checkpoint,...] [--timeout-ms 300000]
```

Output is JSONL on stdout, one envelope per line:

```
{"type":"events","ref":{"project":"P","id":"..."},"events":[...]}
{"type":"timeout"}
{"type":"error","reason":"..."}
```

Exit code is always 0 — errors come through stdout so the harness's "background process completed" notification surfaces them naturally. The CLI **drains** any buffered events newer than `--since` immediately, then streams live events via the adapter's watcher (Obsidian: fs.watch; Jira: poll). It exits on the first non-empty `events` envelope, on timeout, or on error.

Typical use from a subagent or orchestrator:

```
Bash(team-tracking listen --project P --since <last_seen_at> ...,
     run_in_background: true) → handle_1
... do work ...
[harness: "background process handle_1 ended with output: {...}"]
... handle the events, post a response, re-spawn listener ...
```

## Lock state machine

`lock_state` is **derived** from the lock object — not a separate field you set:

| `lock_state` | Condition |
|---|---|
| `free` | `lock == null` |
| `in_progress` | `lock != null` and `lock.last_checkpoint == null` |
| `committed` | `lock != null` and `lock.last_checkpoint != null` |

Orthogonal to `status`. A subtask in status `In Progress` with `lock_state: committed` means the specialist has banked at least one safe-revert SHA and is still working.

## Retry-from-checkpoint contract

When a subagent crashes mid-run:

1. Lock persists on the ticket until its TTL elapses (default 30 min).
2. Orchestrator scans the board; sees `lock_state: committed` on a stale lock.
3. Orchestrator calls `acquire_ticket` — receives `recovered_checkpoint` because the prior holder is past TTL.
4. Orchestrator runs `git checkout <branch> && git reset --hard <recovered_checkpoint.commit_id>`.
5. Orchestrator re-dispatches with the recovered `progress_summary` + `update` as prompt context.
6. New specialist holds a fresh token; its checkpoints overwrite cleanly.

If the stale `lock_state` was `in_progress` (no checkpoint ever recorded), there's no safe SHA to revert to. Treat as a full retry from the branch base.

## Typed errors

Tool calls return `{ isError: true, content: [{ text: "EXXX: <message>" }] }` for invariant violations:

| Code | Meaning |
|---|---|
| `EPARENT` | Parent type incompatible with child type, or a required parent is missing |
| `ETYPE_IMMUTABLE` | `type` or `parent` cannot change after creation |
| `ESTATUS` | Status not allowed for the type (defaults: epic/story/task ∈ {Backlog, Todo, In Progress, In Review, Done}; subtask ∈ {Todo, In Progress, Blocked, Done}) |
| `ELOCKED` | Live, non-stale lock held by someone else |
| `EBADTOKEN` | Supplied `lock_token` doesn't match the active lock |
| `ENOTLOCKED` | Operation requires a lock but none is held |
| `ENOTFOUND` | Ticket ref does not exist |
| `ENOTCONFIGURED` | `./.team-tracking/config.json` missing |

## Field conventions

- `branch` and `pr_url` should be set as soon as either exists — the link between board state and code state.
- `scope` is free-text (typically a module or package name). The orchestrator reads it to detect concurrent-work conflicts; the server does not pattern-match.
- `update` is a one-liner reflected from the latest checkpoint or progress event. `progress_summary` is the rolling cumulative summary, also derived. The full history is in `read_events`.
