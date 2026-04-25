# examples/demo

A snapshot of what `team-tracking-mcp` produces when an orchestrator decomposes work according to the harness-orchestrate / harness-task-team pattern. Browse it directly on GitHub or open it as an Obsidian vault.

## What's in here

```
examples/demo/
  projects/
    Demo/
      board.md                 # rendered kanban (open with the Obsidian Kanban plugin)
      architecture.md
      tickets/
        <slug>/ticket.md       # one folder per top-level epic / story / task
          children/
            <slug>/ticket.md   # nested stories / tasks / pipeline subtasks
```

The Demo project surfaces every shape an orchestrator emits in practice:

| Top-level ticket | What it demonstrates |
|---|---|
| `onboarding-flow` (epic) | Multi-slice initiative; two stories nested below, each with its own pipeline-decomposed task |
| `settings-page` (story) | Top-level story owning a single task with a full TDD pipeline |
| `refresh-api-schemas` (task) | Top-level task in In Progress; the `implement` subtask carries the lock + a recorded checkpoint |
| `spike-shortlist-email-providers` (task) | Done state — every pipeline subtask complete |

Each task is decomposed into pipeline subtasks chosen by the orchestrator. Required: `Implement` plus at least one adversarial code reviewer. Optional: `Write tests`, `Adversarial test review`, `Spec compliance review`, additional code reviewers.

## Open in Obsidian

1. **Open folder as vault** → pick `examples/demo`.
2. Install the **Kanban** community plugin and enable it.
3. Open `projects/Demo/board.md` — each card surfaces its immediate children inline as `[ ] / [x]` checkboxes.

## Regenerate the demo

The committed snapshot may drift slightly from what the populate script produces today. To rebuild it cleanly (or to point it at a different path so the working tree stays clean):

```bash
# default: ./examples/demo (overwrites the snapshot)
pnpm demo

# or pick your own path
pnpm demo ~/scratch/board
```

Under the hood this runs `scripts/setup-demo.sh`: build → reset prior state → run the headless init CLI → run `mcp-server/scripts/populate-demo.mjs`. The `.team-tracking/` config it produces is gitignored, so regenerating into the repo path only diffs the vault content itself.
