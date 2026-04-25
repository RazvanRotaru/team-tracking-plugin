---
name: team-tracking-execute
description: Use when you are a specialist subagent executing a single subtask (implementer, test-writer, adversarial reviewer, etc.). Covers acquiring the lock, recording a checkpoint after every git commit, the pulse-update protocol, and how to escalate work that's too complex back to the orchestrator instead of forcing it through.
---

# team-tracking-execute

You're a specialist running one subtask end-to-end. The orchestrator handed you a `TicketRef`. This skill is the protocol you follow against the team-tracking MCP server. Lower-level tool reference: [`team-tracking-usage`](../team-tracking-usage/SKILL.md).

## When to use

You've been dispatched to do **exactly one subtask**. You have a `ref = { project, id }` and a clear definition of what "done" looks like for your role.

## Pre-flight

```
get_ticket(ref)
```

Read the body, `scope`, `branch`, and prior `progress_summary`. If `lock_state` looks live and was last touched recently, **stop** — there's a concurrency bug upstream. Append a log line and exit; the orchestrator will sort it out.

## Acquire

```
acquire_ticket(ref, owner="<role>@<dispatch-id>")
→ { lock_token, recovered_checkpoint }
```

Use an `owner` a human reading the board can decode (`implementer@dispatch-7`, `adversarial-code-reviewer@dispatch-12`).

**If `recovered_checkpoint != null`**: a previous specialist crashed mid-run. Their last good state is the SHA in `recovered_checkpoint.commit_id`. Before doing anything else:

```bash
git checkout <branch>
git reset --hard <recovered_checkpoint.commit_id>
```

Read `recovered_checkpoint.update` + `progress_summary` for context, then resume from there.

## During work

The orchestrator polls every 5–10 minutes while you work — reading your `progress_summary`, your `update` line, and the diff of your last checkpoint SHA. That's how it catches drift, hallucination, and stuck loops early. Two implications:

- **Checkpoint often.** A long silence (no new checkpoint for >15 min) reads as "stuck or crashed" from the outside. Bank a SHA whenever there's a coherent unit of progress.
- **Don't lie in the visible fields.** `progress_summary` should describe what the diff actually contains. If you claim to have written tests but the diff has none, the orchestrator (and the adversarial reviewer that reads the diff) will catch it — and rightly distrust the rest of your output.

After **every** git commit you intend to keep:

```
commit_checkpoint(ref, {
  lock_token,
  commit_id,                           # the SHA you just made
  update: "one line, what you just did",
  progress_summary: "rolling cumulative state",
})
```

The server records the SHA without verifying — you must have actually made the commit on `branch`. The checkpoint is the safe revert point if you crash; it's how the orchestrator's retry flow recovers your work.

Between commits, when you want to surface progress without recording a SHA:

```
report_progress(ref, {
  lock_token,
  update: "writing the retry policy",
  progress_summary: "queue config done; retry path 60% drafted",
})
```

For audit-worthy events (decisions, gotchas, recovered errors):

```
append_log(ref, "switched provider from X to Y because <reason>")
```

`append_log` doesn't require a lock token — anyone may write to it.

## Release

When the subtask passes its acceptance criteria:

```
release_ticket(ref, { lock_token, final_status: "Done" })
```

**Don't release as Done unless** you can defend the criteria for your role:
- Test writer → tests run and fail in the way they're supposed to
- Implementer → all tests green, no regressions
- Adversarial reviewer → review report committed; no unaddressed issues at a level you'd block on

If you can't defend `Done`, see escalation below.

## Escalation: too complex / wrong specialist

Subtasks sometimes turn out bigger than one specialist session. **Don't force it through.** Don't silently leave half-done work. Escalate.

### Signals you should escalate

- The subtask requires changes in modules you weren't told about
- Acceptance criteria are ambiguous and you're guessing
- The work splits naturally into 3+ commits with conceptually different scope
- You hit an architectural decision the orchestrator should make
- The work is mostly outside your role (an implementer staring at schema design)

### How to escalate

1. **Stop.** Don't commit half-finished code that won't pass review.
2. Surface the request via the visible fields:

   ```
   report_progress(ref, {
     lock_token,
     update: "ESCALATION: <one-line summary>",
     progress_summary: <multi-line: what you tried, where it grew,
                       proposed split / reassign, what the orchestrator
                       needs to decide>,
   })
   ```

3. Audit the request:

   ```
   append_log(ref, "ESCALATION: requesting <split | reassign | both>. See progress_summary.")
   ```

4. Release as Blocked:

   ```
   release_ticket(ref, { lock_token, final_status: "Blocked" })
   ```

The orchestrator polls `list_board` and reads your `progress_summary` as the briefing. Make it good.

### Proposing a split

If the subtask should be decomposed further, name the cuts you'd make. Example `progress_summary`:

```
Tried "Implement OAuth flow" as one subtask. Two clean cuts emerged:
  1. Token exchange + refresh (no UI)
  2. Provider config (Google + LinkedIn) — reusable for future SSO
Recommend splitting before re-dispatching. Architect should weigh in
on whether (2) belongs in a separate story.
```

### Proposing a reassign

If the work needs different expertise, say so explicitly:

```
This subtask is 80% schema design + 20% code. Recommend reassigning
to a specialist with database authority, or pre-approving the schema
with the architect before re-dispatching an implementer.
```

### Proposing both

When the work needs decomposition AND different specialists for each piece, list them together. The orchestrator can act on both signals at once.

## Common errors

| Error | What it means | What to do |
|---|---|---|
| `EBADTOKEN` | Your `lock_token` doesn't match the active lock | The lock got stolen (TTL expired). Don't retry — return; the orchestrator will redispatch with a fresh one |
| `ENOTLOCKED` | Lock-bound call with no lock held | You released or never acquired. Re-acquire if you still need to work |
| `ELOCKED` | Someone else holds a live lock | Don't fight it. Append a log and exit |
| `ESTATUS` | Tried a status not allowed for the type | Check the type's vocabulary; adjust |

## Red flags

- **Never** call `commit_checkpoint` without actually making the git commit. The recovery flow assumes the SHA exists on the branch.
- **Never** release as Done if you couldn't validate the acceptance criteria. Use `Blocked` + escalation.
- **Never** silently abandon a subtask. Either `Done` or `Blocked` with a useful summary.
- **Never** edit the parent task or other subtasks. Stay in your lane; talk to the orchestrator instead.
