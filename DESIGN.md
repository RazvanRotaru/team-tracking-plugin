# team-tracking-mcp — Design

Claude Code plugin that ships an MCP server + web-based init + swappable tracker adapters. The MCP server is the orchestrator's contract for reading and mutating a project's tracked work. Adapters translate between a neutral ticket model and a concrete tracker (Jira or Obsidian Kanban). No side-store — the tracker is the only persistence.

## Goals

- One neutral API; two concrete backends today (Jira, Obsidian Kanban); pluggable for more later.
- The tracker is the only store. The board is auditable. Nothing important lives in files outside the tracker.
- Specialists (subagents) can safely report progress mid-run and resume after a crash without losing partial work.
- Orchestrator never has to parse markdown or JSON to reason about state; `list_board` is enough.

## Non-goals

- Reverse webhooks / bidirectional sync. Polling is enough for v1; humans editing the tracker directly is visible on next read.
- Multiple concurrent orchestrators against the same project. The server assumes one writer; multi-writer coordination is future work.
- A tracker's full feature set (sprints, velocity, custom workflows). We model only what orchestration needs.

## Glossary

- **Tracker** — the external system of record (Jira, Obsidian Kanban).
- **Adapter** — the code that translates our neutral model to the tracker's native shape.
- **Ticket** — a unit of tracked work. Four types: `epic`, `story`, `task`, `subtask`.
- **Lock** — an in-server mutex claimed by a subagent while it works on a ticket.
- **Checkpoint** — a durable record of a subagent's last safe state: a git commit plus a progress snapshot.

## Ticket type hierarchy

```
epic
 └─ story
     └─ task
         └─ subtask   (leaf — the unit a specialist owns)
```

Allowed parent relationships, enforced by the server:

| Type | Parent ∈ |
|---|---|
| `epic` | `null` |
| `story` | `{epic, null}` |
| `task` | `{story, epic, null}` |
| `subtask` | `{task, story}` |

Jira native hierarchy is 3 levels (Epic → Story/Task → Sub-task). The adapter fakes the fourth level (`story → task`) with Jira's "is parent of" issue link. Obsidian Kanban has no native hierarchy; the adapter uses folder nesting and wiki-links.

PRD → top-level ticket mapping (chosen by the caller at `create_ticket` time, not inferred):

| PRD complexity | Top-level type |
|---|---|
| Multi-slice feature | `epic` |
| Single feature | `story` |
| One-off change | `task` |

## Type model

```ts
type TicketType = "epic" | "story" | "task" | "subtask";
type Priority = "P0" | "P1" | "P2";
type LockState = "free" | "in_progress" | "committed";

type TicketRef = { project: string; id: string }; // id is adapter-opaque

type Checkpoint = {
  commit_id: string;         // git SHA on the ticket's branch
  update: string | null;
  progress_summary: string | null;
  at: string;                // ISO-8601
};

type Lock = {
  owner: string;             // subagent identifier provided at acquire
  token: string;             // server-minted; required for all mutations by the lock holder
  acquired_at: string;       // ISO-8601
  last_checkpoint: Checkpoint | null;
};

type TicketDTO = {
  ref: TicketRef;
  type: TicketType;
  parent: TicketRef | null;
  title: string;
  body: string;              // markdown
  status: string;            // adapter-native; = board column
  priority: Priority;
  labels: string[];
  scope: string | null;      // free-text conflict signal; orchestrator reads, doesn't pattern-match
  branch: string | null;
  pr_url: string | null;
  update: string | null;          // latest one-liner; overwritten each checkpoint
  progress_summary: string | null; // rolling cumulative summary; overwritten each checkpoint
  lock_state: LockState;     // derived: free | in_progress | committed
  lock: Lock | null;         // present when lock_state != "free"; orchestrator-visible
  created: string;
  updated: string;
  children: TicketRef[];     // resolved on read
};

type TicketSummaryDTO = {
  ref: TicketRef;
  type: TicketType;
  title: string;
  status: string;
  priority: Priority;
  scope: string | null;
  branch: string | null;
  update: string | null;     // included for cheap scanning
  lock_state: LockState;
};

type CreateTicketDTO = {
  type: TicketType;
  parent?: TicketRef;
  title: string;
  body?: string;
  priority?: Priority;
  labels?: string[];
  scope?: string;
};

type UpdateDTO = Partial<Pick<
  TicketDTO,
  "title" | "body" | "status" | "priority" | "labels" | "scope" | "branch" | "pr_url"
>>;

type ReportProgressDTO = {
  status?: string;
  update?: string;
  progress_summary?: string;
};

type CommitCheckpointDTO = {
  commit_id: string;
  update?: string;
  progress_summary?: string;
};
```

## Status vocabulary

Adapter config declares allowed statuses per type. Defaults:

| Type | Allowed statuses |
|---|---|
| `epic`, `story`, `task` | `Backlog`, `Todo`, `In Progress`, `In Review`, `Done` |
| `subtask` | `Todo`, `In Progress`, `Blocked`, `Done` |

Status and `lock_state` are orthogonal. A subtask in `In Progress` with a live lock and no checkpoint has `lock_state: "in_progress"`. Same subtask after a checkpoint has `lock_state: "committed"`. The status column stays `In Progress` through both.

## Lock + checkpoint semantics

Locking arbitrates writes on a ticket. The server holds an in-process mutex keyed by `TicketRef` to sequence acquire/commit/release. Adapters are called inside the mutex; atomicity is the server's responsibility, not the tracker's.

### Lifecycle

```
                    acquire_ticket
         free ─────────────────────► in_progress
          ▲                               │
          │                               │ commit_checkpoint
          │   release_ticket              ▼
          └───────────────────────────  committed
                                          │
                                          │ commit_checkpoint (update SHA)
                                          └──► committed  (self-loop)
                                          │
                                          │ release_ticket
                                          ▼
                                         free
```

### Acquire

`acquire_ticket(ref, { owner })` → `{ lock_token }`

- Atomic. If `lock_state == "free"` or the existing lock is past TTL, the server mints a `lock_token`, sets `lock = { owner, token, acquired_at: now, last_checkpoint: null }`, transitions `lock_state` to `in_progress`, and transitions the ticket's `status` to `In Progress` if it was `Todo`.
- Errors with `ELOCKED` if a live lock is held by a different token.

### Commit checkpoint

`commit_checkpoint(ref, { lock_token, commit_id, update?, progress_summary? })` → `void`

- Atomic. Requires `lock.token == lock_token`.
- Writes `lock.last_checkpoint = { commit_id, update, progress_summary, at: now }`.
- Writes `update` and `progress_summary` to the visible `TicketDTO` fields.
- Transitions `lock_state` → `committed`. Does not change `status`.
- Precondition: the specialist must have already created the git commit with SHA `commit_id`. The server does not verify — it just records.

### Release

`release_ticket(ref, { lock_token, final_status })` → `void`

- Atomic. Clears the lock. Sets `status = final_status`. Transitions `lock_state` → `free`.
- Typical `final_status`: `Done` (work complete) or `Blocked` (needs human).

### Stale lock recovery

- Default lock TTL: 30 minutes (configurable).
- On `acquire_ticket` against a stale lock, the server preserves `lock.last_checkpoint` in the returned response as `recovered_checkpoint` and then overwrites the lock with the new owner. The orchestrator decides whether to `git reset --hard recovered_checkpoint.commit_id` before dispatching.

### Retry flow

When a subagent runs out of tokens mid-execution:

1. Subagent has acquired, possibly committed N checkpoints (each with a git SHA).
2. Process dies. Lock persists until TTL.
3. Orchestrator scans the board; sees `lock_state: "committed"` and a stale `lock.acquired_at`.
4. Orchestrator calls `acquire_ticket` — server returns new `lock_token` plus the `recovered_checkpoint`.
5. Orchestrator runs `git checkout <branch> && git reset --hard <recovered_checkpoint.commit_id>` in the workspace.
6. Orchestrator dispatches retry with the recovered `progress_summary` and `update` as prompt context.
7. New subagent resumes work from the last known-good state.

If `lock_state` was `in_progress` (acquired but never checkpointed), there is no safe SHA to revert to. The orchestrator treats it as a full retry from the last known commit on the branch (typically the branch base).

## Adapter interface

```ts
interface TrackerAdapter {
  init(config: AdapterConfig): Promise<void>;

  listBoard(project: string): Promise<TicketSummaryDTO[]>;
  getTicket(ref: TicketRef): Promise<TicketDTO | null>;
  listChildren(ref: TicketRef): Promise<TicketDTO[]>;

  createTicket(project: string, draft: CreateTicketDTO): Promise<TicketRef>;
  updateTicket(ref: TicketRef, update: UpdateDTO): Promise<void>;

  // Called inside the server's mutex. Adapters may assume no concurrent calls for the same ref.
  writeLock(ref: TicketRef, lock: Lock | null): Promise<void>;
  writeProgress(ref: TicketRef, progress: { update: string | null; progress_summary: string | null }): Promise<void>;
  appendLog(ref: TicketRef, line: string): Promise<void>;
}
```

Eight methods. The server handles all lock state-machine logic and mutex discipline; adapters only persist whatever the server hands them.

## MCP tool surface

Seven tools total.

### Reads

- `list_board(project)` → `TicketSummaryDTO[]` — priority order: `In Progress` → `Todo` → `Backlog`, then `In Review` and `Done` excluded by default (opt in via filter).
- `get_ticket(ref)` → `TicketDTO`
- `list_children(ref)` → `TicketDTO[]`

### Writes — orchestrator

- `create_ticket(project, draft)` → `TicketRef`
- `update_ticket(ref, update)` → `void`

### Writes — specialist (mid-run)

- `acquire_ticket(ref, owner)` → `{ lock_token: string; recovered_checkpoint: Checkpoint | null }`
- `commit_checkpoint(ref, { lock_token, commit_id, update?, progress_summary? })` → `void`
- `release_ticket(ref, { lock_token, final_status })` → `void`
- `report_progress(ref, { lock_token, status?, update?, progress_summary? })` → `void` — non-checkpoint updates (no git SHA required). Used between commits for the pulse fields.
- `append_log(ref, line)` → `void` — append-only audit trail. Not behind the lock; anyone can log.

Nine tools. (Three core read, two orchestrator write, three lock-state write, one log.)

## Server invariants

The server enforces these before delegating to the adapter:

1. `create_ticket.parent` satisfies the type-parent table.
2. `update_ticket` cannot change `type` or `parent` after creation.
3. `status` must be in the adapter's allowed set for the ticket's type.
4. `acquire_ticket` fails if a live lock exists with a different token.
5. `commit_checkpoint`, `release_ticket`, `report_progress` require the current `lock_token`.
6. Lock operations are serialized per `TicketRef` via an in-process mutex.

Invariant violations are typed errors (`EPARENT`, `ETYPE_IMMUTABLE`, `ESTATUS`, `ELOCKED`, `EBADTOKEN`, `ENOTLOCKED`). The server returns MCP `isError: true` with the error code in the content.

## Obsidian adapter

Absorbs the behavior of the old `init-obsidian-kanban-project` and `prd-to-obsidian-kanban` skills. No `harness-progress.json`.

### Layout

```
<vault>/projects/<Project>/
  board.md                           # kanban-plugin markdown
  architecture.md
  tickets/
    <slug>/
      ticket.md                      # frontmatter + body + "## Children" section
      children/
        <child-slug>/
          ticket.md                  # recursive: same shape as parent
```

Every ticket — epic, story, task, subtask — is a folder with a `ticket.md`. Children are subfolders. A ticket's body ends with a `## Children` section containing a checklist where each item is `- [{x|space}] [[children/<slug>/ticket|<slug>]]`. Tick state derived from the child's `status == "Done"` on read.

### Frontmatter

```yaml
---
type: subtask
parent: tickets/<parent-slug>
status: In Progress
priority: P1
labels: [backend, auth]
scope: "auth module"
branch: feat/oauth-login
pr_url: null
update: "writing tests for token exchange"
progress_summary: "spec'd the flow; 3 tests in progress"
lock:
  owner: "test-writer@subagent-abc"
  token: "tok_7h3n..."
  acquired_at: "2026-04-24T10:15:00Z"
  last_checkpoint:
    commit_id: "a1b2c3d"
    update: "wrote happy-path tests"
    progress_summary: "7 tests covering basic flows"
    at: "2026-04-24T10:18:00Z"
created: "2026-04-24T10:00:00Z"
updated: "2026-04-24T10:18:00Z"
---
```

### Board rendering

Top-level tickets (epics, standalone stories/tasks) appear as cards on `board.md`:

```
- [ ] [[tickets/<slug>/ticket|<slug>]] #P1 #story
```

Subtasks are not on the board; they live only as children inside their parent's folder and render as the checklist inside the parent's body. Tasks under stories are listed inside the parent story's `## Children` section with a link into the task's folder.

### Init (PRD → tickets)

- Inputs: PRD path, target project, target top-level type (`epic` | `story` | `task`).
- Creates one top-level ticket, N child tickets (stories under an epic; tasks under a story; etc.) by driving `createTicket` through the adapter. No special-case code paths — init is just a scripted sequence of `create_ticket` calls.

### Append log

Logs append to a `## Log` section in `ticket.md`, each line prefixed with ISO timestamp.

## Jira adapter

### Mapping

| Neutral | Jira |
|---|---|
| `epic` | Epic |
| `story` | Story |
| `task` | Task |
| `subtask` | Sub-task |
| `parent` (native) | Parent field / Epic Link |
| `parent` (story → task) | Issue link of type "is parent of" |
| `status` | Workflow status (configured in adapter config to match neutral vocabulary) |
| `priority` | Priority (mapped: P0 → Highest, P1 → High, P2 → Medium) |
| `labels` | Labels |
| `scope` | Custom field "Scope" (text); fallback: a fenced section in description |
| `branch` | Custom field "Branch"; fallback: same |
| `pr_url` | Remote link or custom field |
| `update` | Custom field "Update" (short text); fallback: fenced `<!-- update -->…<!-- /update -->` in description |
| `progress_summary` | Custom field "Progress Summary" (text); fallback: fenced section |
| `lock` | Custom field "Lock" (JSON-encoded text); fallback: fenced section |
| `append_log` | Comment |

If custom fields are not configured, the adapter falls back to fenced sections in the description — always functional, never prettier. The init webpage explains the tradeoff and lets the user choose.

### Status vocabulary

Configured in the init UI: user maps our canonical statuses (`Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Blocked`) to their Jira workflow statuses. The adapter uses this map on every read and write.

## Init command + webpage

### Slash command

`/team-tracking:init` runs a node script that:

1. Starts an HTTP server on `127.0.0.1:<random-free-port>`.
2. Mints a one-time URL token; assembles URL `http://127.0.0.1:<port>/?t=<token>`.
3. Opens the URL in the default browser.
4. Blocks until the page POSTs the config or the user cancels.
5. Writes `./.team-tracking/config.json`.
6. If `./.git/` exists: ensures `.team-tracking/` is listed in `./.gitignore`; creates `.gitignore` if missing.
7. Shuts down the HTTP server. Prints a summary.

### Config shape

```json
{
  "version": 1,
  "adapter": "jira",
  "adapterConfig": {
    "baseUrl": "https://acme.atlassian.net",
    "email": "you@acme.com",
    "apiToken": "…",
    "statusMap": { "Backlog": "To Do", "Todo": "Selected", "In Progress": "In Progress", "In Review": "In Review", "Done": "Done", "Blocked": "Blocked" },
    "customFieldIds": { "update": "customfield_10050", "progress_summary": "customfield_10051", "lock": "customfield_10052", "scope": "customfield_10053", "branch": "customfield_10054" }
  },
  "projects": [
    { "name": "Autopilot", "adapterProjectRef": "AUTO" }
  ],
  "lockTtlSeconds": 1800
}
```

For Obsidian:

```json
{
  "version": 1,
  "adapter": "obsidian-kanban",
  "adapterConfig": { "vaultPath": "./vault" },
  "projects": [
    { "name": "Autopilot", "adapterProjectRef": "projects/Autopilot" }
  ],
  "lockTtlSeconds": 1800
}
```

### Webpage

Static SPA (plain HTML + vanilla JS is fine; no bundler needed for v1). Three screens:

1. **Pick adapter** — two tiles: Jira, Obsidian Kanban.
2. **Configure adapter** — adapter-specific form.
   - Jira: base URL, email, API token, test-connection button, discovered projects picker, status mapping UI, optional custom-field IDs.
   - Obsidian: vault picker, project folder picker, confirmation.
3. **Review + save** — shows the assembled config, confirm button → POSTs to the local server.

Security: server only binds `127.0.0.1`, rejects requests without the one-time token, single-serves the HTML once, shuts down after save.

## Plugin packaging

```
team-tracking-mcp/
  .claude-plugin/
    plugin.json
  commands/
    init.md
    status.md
    reconfigure.md
  mcp-server/
    src/
      index.ts
      domain/
        types.ts
        invariants.ts
        lock.ts
      server/
        tools.ts
        mutex.ts
      adapters/
        types.ts
        jira/
          index.ts
          rest.ts
          status-map.ts
        obsidian-kanban/
          index.ts
          vault-io.ts
          board-edit.ts
      config/
        loader.ts
        gitignore.ts
      init/
        cli.ts
        server.ts
        web/             # static SPA
    package.json
    tsconfig.json
  skills/
    team-tracking-usage/
      SKILL.md           # tells the orchestrator how to use the 9 tools
```

`plugin.json` declares:

- The MCP server (stdio, `node mcp-server/dist/index.js`)
- The three slash commands
- The `team-tracking-usage` skill

## Failure modes

- **Adapter unreachable** — tool calls return `EADAPTER_UNREACHABLE` with the underlying reason. Orchestrator surfaces to user; no retries inside the server.
- **Stale lock** — handled by the server on `acquire_ticket` (TTL-based).
- **Clock skew** — lock TTL uses the server's clock. No cross-process time comparisons.
- **Config missing** — `/team-tracking:status` reports "not initialized"; every tool call errors `ENOTCONFIGURED`.
- **Concurrent MCP servers** — undefined behavior in v1. Document as a non-goal.

## Open items for future iterations

- Worktree-aware checkpointing (when subagents run in isolated git worktrees — relevant for pi-cc-plugin).
- Reverse webhook support on Jira.
- Custom tracker adapters (Linear, GitHub Projects).
- Per-project adapter (mixing Jira and Obsidian in one workspace).
