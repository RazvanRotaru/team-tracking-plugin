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

## Polling specialists in flight

Long-running specialists drift. They hallucinate (claim work that isn't in the diff), scope-creep (start touching files outside the subtask), or get stuck looping (same `progress_summary` poll after poll). Don't wait for the release — check in.

### Cadence

**Every 5–10 minutes** while any subtask is in flight. Faster (e.g. every minute) is noise for everyone — the audit log floods, Jira may rate-limit, and humans watching the board lose signal. Slower (>15 min) lets drift compound past the point where a corrective re-dispatch is cheap.

### What to read

```
list_board(project)
```

For each ticket where `lock_state ∈ {"in_progress", "committed"}`:

```
get_ticket(ref)
```

Then for any ticket where `lock_state == "committed"`, **inspect the actual diff** of the last checkpoint:

```bash
git show <lock.last_checkpoint.commit_id>
```

The board tells you what the specialist *says* it did; the diff tells you what it actually did. They don't always agree — that's the whole reason to poll.

### Heartbeat

```
last_activity = max(lock.acquired_at, lock.last_checkpoint?.at)
age           = now - last_activity
```

| Age | Interpretation | Action |
|---|---|---|
| < 5 min | Healthy | Move on |
| 5–15 min | Normal for non-trivial work | Read `progress_summary`. Confirm it tracks the spec |
| 15–30 min | Concerning | Inspect the last commit's diff. If on-spec, give it room. If drifting, prepare a corrective dispatch |
| > TTL (default 30 min) | Stale lock | Lock is recoverable. Re-acquire to claim `recovered_checkpoint` and re-dispatch |

### Drift signals

Reading `update`, `progress_summary`, and the recent commit's diff together:

- **Scope creep** — `progress_summary` mentions modules, files, or behaviors outside the subtask spec. The diff confirms files outside the expected scope changed. Note it; budget extra time for the adversarial code review to flag it.
- **Hallucination** — the summary claims work that isn't in the diff (e.g. "added integration tests for X" but no test files appear). Don't trust the visible fields; trust the diff. Adversarial review will catch this; your job is to make sure it gets there.
- **Stuck loop** — two consecutive polls show the same `progress_summary` and no new checkpoint SHA. The specialist is spinning. Try a nudge (below); if the next poll still shows no progress, plan to recover via TTL.

### Corrective levers — the steering channel

Specialists running [`team-tracking-execute`](../team-tracking-execute/SKILL.md) check `read_messages(ref, since=lastSeen)` at every checkpoint cycle. That's your synchronous-looking interrupt: post a message and the executor will pick it up the next time it pauses.

```
post_message(ref, {
  from: "orchestrator",
  kind: "nudge" | "question",
  body: "Stay within auth/ — billing/ is out of scope.",
})
→ { id: "msg_abc...", at: "2026-04-25T10:30:00Z" }
```

What `kind` to use:
- `nudge` — directional ("stay in scope X", "stop adding tests"). Executor ACKs.
- `question` — answer expected ("what blocked the retry path?"). Executor responds.

After posting, on your next 5–10 min sweep, read responses:

```
read_messages(ref, since=<your last sweep>)
```

Look for `kind == "response"` or `kind == "ack"` with `from == "executor"` (or whatever role identifier the specialist used).

### When the channel isn't enough

1. **Wait out the TTL** — if the specialist is unresponsive (no new checkpoint past TTL, no message reply), the lock becomes recoverable. `acquire_ticket` returns the prior `recovered_checkpoint` and you can re-dispatch with corrective context.
2. **Surface to the user / architect** — when drift is consequential (data loss, time pressure, architectural mistake), don't quietly absorb it. Post a `question` *and* surface to a human in parallel.

What you should **not** do:

- Don't force-acquire a non-stale lock. The lock contract protects in-flight work; bypassing it corrupts state.
- Don't update or rewrite the subtask's body / status while the specialist holds the lock — they may rely on those fields.
- Don't over-poll the board. 5–10 min is the sweet spot. Re-reading every minute is noise; agents need contiguous focus too.
- Don't post a message every few minutes "just to check." The steering channel is for substantive guidance; flooding it makes specialists ignore it.

## Polling for blocked / completed

Same `list_board(project)` call covers it. Look for:
- `Blocked` tickets — read `progress_summary` (the executor wrote you a briefing) and act: split, reassign, or surface to the user.
- Stale `committed` locks past TTL with the same checkpoint for too long — likely crashed; recover via re-acquire.
- Newly `Done` subtasks — dispatch the next pipeline stage if there is one.

## Red flags

- **Don't create a task without subtasks.** A bare task is half-done planning.
- **Don't acquire locks.** That's the specialist's job.
- **Don't promote `Todo` → `In Progress` yourself.** It happens automatically when a specialist acquires the lock.
- **Don't reuse `scope` strings inconsistently.** Pick a vocabulary (typically module/package names) and stick to it.
- **Don't dispatch a task whose subtasks contradict each other.** Re-read the spec when in doubt.
