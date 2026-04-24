# team-tracking-mcp — Implementation Plan

Ordered milestones. Each milestone is independently testable, lands behind real integration tests, and produces something usable. No milestone depends on later ones.

## Principles

- TypeScript + Node 20. `tsc` strict. Biome for lint/format.
- Pure domain layer (types, invariants, lock state machine) — zero Node/IO dependencies. Unit tested in isolation.
- Adapters are the only layer that does IO. Tested with real targets (a throwaway Jira sandbox + a tmp vault).
- Server is a thin composition: `validate → acquire mutex → adapter.* → release mutex`.
- No mocking of adapters in server tests — use the real Obsidian adapter against a temp dir.

## Milestone 1 — Repo scaffold

**Deliverable:** clean `team-tracking-mcp/` with working build, test, lint commands.

- `package.json` with scripts: `build`, `test`, `lint`, `typecheck`, `dev`, `init`.
- `tsconfig.json` strict.
- `biome.json`.
- `mcp-server/` workspace with its own `package.json` pointing at `src/index.ts`.
- Empty `.claude-plugin/plugin.json` stub.
- GitHub Actions workflow: typecheck + test on PR.

**Done when:** `pnpm install && pnpm build && pnpm test` passes green with one smoke test.

## Milestone 2 — Domain layer

**Deliverable:** all types + invariant checks + lock state machine, no IO.

Files:

- `src/domain/types.ts` — every DTO from DESIGN.md, exported.
- `src/domain/invariants.ts` — pure functions:
  - `validateCreate(draft, parent): Result<void, Error>`
  - `validateUpdate(current, update): Result<void, Error>`
  - `validateStatusForType(type, status, adapterStatusMap): Result<void, Error>`
  - `allowedParentTypes(type): TicketType[]`
- `src/domain/lock.ts` — pure lock state transitions:
  - `acquire(currentLock, owner, now, ttl): Result<{ nextLock, recoveredCheckpoint }, Error>`
  - `checkpoint(currentLock, token, checkpoint): Result<nextLock, Error>`
  - `release(currentLock, token): Result<void, Error>`
  - `reportProgress(currentLock, token, progress): Result<nextLock, Error>`
  - `deriveLockState(lock): LockState`

Errors are tagged unions, not thrown: `{ kind: "ELOCKED" | "EBADTOKEN" | "EPARENT" | …, message: string }`.

**Tests:** exhaustive state-machine tests for `lock.ts` (every transition, every error branch). Property tests for `invariants.ts` parent-type table.

**Done when:** coverage on `src/domain/` > 95%, no IO imports in the folder.

## Milestone 3 — Adapter interface + test harness

**Deliverable:** the `TrackerAdapter` interface and a conformance test suite that any adapter must pass.

Files:

- `src/adapters/types.ts` — `TrackerAdapter`, `AdapterConfig`, `AdapterCapabilities`.
- `test/adapter-conformance.ts` — exported function `runConformance(name, makeAdapter: () => Promise<TrackerAdapter>)` that runs ~30 black-box tests covering:
  - Create/read/update roundtrip for each type.
  - Parent resolution.
  - `listBoard` ordering.
  - `writeLock` persists and reads back every field.
  - `writeProgress` overwrites, doesn't accumulate.
  - `appendLog` accumulates.
  - Status vocabulary validation.

The server itself reuses `runConformance` against both adapters in CI.

**Done when:** `runConformance` is callable from any adapter's test file.

## Milestone 4 — Obsidian Kanban adapter

**Deliverable:** full adapter against a real temp vault. This is the simpler backend; ship it first.

Files:

- `src/adapters/obsidian-kanban/vault-io.ts` — read/write `ticket.md`, parse/serialize frontmatter, extract/inject `## Children` and `## Log` sections.
- `src/adapters/obsidian-kanban/board-edit.ts` — atomic single-Edit updates to `board.md` preserving `kanban-plugin: board` frontmatter.
- `src/adapters/obsidian-kanban/index.ts` — implements `TrackerAdapter`:
  - `createTicket` → creates folder, writes `ticket.md`, adds to parent's `## Children` section (or `board.md` if top-level).
  - `listBoard` → reads `board.md`, resolves wiki-links, loads frontmatter for summaries.
  - `getTicket` → reads folder, recursively lists `children/`.
  - `writeLock`, `writeProgress` → frontmatter edits, idempotent.
  - `appendLog` → append to `## Log` section.

Design constraints:

- Every write is a single atomic file replacement (`writeFile` to tmp + rename). No partial writes.
- `board.md` edits preserve the exact frontmatter and column headers byte-for-byte.
- Absorbs the logic from the old `init-obsidian-kanban-project` skill: if the project folder doesn't exist, adapter `init` scaffolds it (`board.md`, `tickets/`, `architecture.md`).

**Tests:** `runConformance("obsidian-kanban", () => new ObsidianKanbanAdapter(tmpVault))`.

**Done when:** all conformance tests pass against a temp vault.

## Milestone 5 — MCP server wiring

**Deliverable:** the MCP server exposing the 9 tools, backed by the Obsidian adapter.

Files:

- `src/server/mutex.ts` — per-`TicketRef` async mutex. `withLock(ref, async () => …)`.
- `src/server/tools.ts` — one exported function per tool. Each:
  1. Validates args with zod.
  2. Loads current ticket via `adapter.getTicket`.
  3. Applies domain invariants / lock state machine.
  4. Persists via adapter calls inside the mutex.
  5. Returns the canonical DTO shape.
- `src/index.ts` — MCP server bootstrap using `@modelcontextprotocol/sdk`. Reads `./.team-tracking/config.json`, instantiates adapter, registers tools.

Error translation: domain `Result` errors → MCP `{ isError: true, content: [{ type: "text", text: "EXXX: <message>" }] }`.

**Tests:**

- Unit tests for each tool with a stubbed adapter.
- End-to-end test: spawn the server as a child process, speak MCP over stdio, exercise the full lock cycle (acquire → commit → release) against a real temp vault.

**Done when:** full acquire/commit/release cycle works via MCP client, lock TTL expiry reclaims stale locks, invariant violations return typed errors.

## Milestone 6 — Config + init CLI (headless)

**Deliverable:** config loader, gitignore helper, and a non-webpage CLI mode for scripted init.

Files:

- `src/config/loader.ts` — reads + validates `./.team-tracking/config.json`, zod-schema.
- `src/config/gitignore.ts` — idempotent append of `.team-tracking/` to `.gitignore`, creating the file if missing.
- `src/init/cli.ts` — `team-tracking init --adapter obsidian-kanban --vault ./vault --project Autopilot` writes config directly. Useful for tests and CI.

**Done when:** config survives full roundtrip (write → load → use in server), `.gitignore` is updated correctly in a repo with or without a pre-existing file.

## Milestone 7 — Init webpage

**Deliverable:** the interactive init flow.

Files:

- `src/init/server.ts` — ephemeral HTTP server, one-time token, graceful shutdown.
- `src/init/web/index.html`, `src/init/web/app.js`, `src/init/web/style.css` — three-screen SPA. No framework.
- Extends `src/init/cli.ts` so `team-tracking init` (no args) launches the webpage.

Screens:

1. Pick adapter.
2. Adapter config — Obsidian path picker / Jira creds + test-connection + status map.
3. Review + save.

**Tests:** headless browser test (playwright) driving through all three screens, asserting the resulting config file.

**Done when:** `team-tracking init` opens a browser, user clicks through, config is written correctly for both adapters, server shuts down cleanly.

## Milestone 8 — Jira adapter

**Deliverable:** Jira adapter passing the same conformance suite.

Files:

- `src/adapters/jira/rest.ts` — thin REST wrapper: `getIssue`, `createIssue`, `editIssue`, `searchJql`, `addComment`, `createIssueLink`.
- `src/adapters/jira/status-map.ts` — maps neutral status ↔ Jira workflow status per config.
- `src/adapters/jira/index.ts` — implements `TrackerAdapter`:
  - Uses custom fields when configured; falls back to fenced sections in description for `update`, `progress_summary`, `lock`, `scope`, `branch`.
  - `listBoard` → JQL query for the project, ordered by status + priority.
  - `getTicket` → issue + children (subtasks natively; `story → task` via "is parent of" link query).
  - `writeLock`, `writeProgress` → issue edit with CAS via `If-Match` where available, otherwise read-modify-write inside the server mutex (safe for single-server assumption).
  - `appendLog` → add comment.

**Tests:** `runConformance("jira", …)` against a throwaway Jira sandbox. Gated behind `JIRA_TEST_CREDS` env; skipped in OSS CI.

**Done when:** conformance passes against the sandbox; fenced-section fallback tested independently with unit tests.

## Milestone 9 — Plugin packaging

**Deliverable:** installable Claude Code plugin.

Files:

- `.claude-plugin/plugin.json` — registers the MCP server (stdio command), the three slash commands, and the skill.
- `commands/init.md`, `commands/status.md`, `commands/reconfigure.md` — slash command definitions that exec the CLI.
- `skills/team-tracking-usage/SKILL.md` — tells the orchestrator:
  - When to use each tool.
  - The lock/checkpoint protocol for specialists (acquire → commit_checkpoint after each git commit → release).
  - The retry contract: if `lock_state == "committed"` on a stale lock, reset to `recovered_checkpoint.commit_id` and re-dispatch.
  - How to interpret `list_board` ordering.

**Done when:** `/plugin install team-tracking-mcp` in Claude Code registers the MCP server, `/team-tracking:init` opens the webpage, orchestrator skill pulls up correctly.

## Milestone 10 — End-to-end test (scripted MCP client)

**Deliverable:** end-to-end test that drives the plugin's MCP server over stdio and exercises the full retry-from-checkpoint story.

- Run in CI against the Obsidian adapter (deterministic, no external deps, no API keys).
- Test harness is a scripted MCP client (`@modelcontextprotocol/sdk` client in Node) that speaks MCP over stdio.
- The script sequences: create an epic → create child subtasks → `acquire_ticket` → `commit_checkpoint` with a fake commit SHA → simulate crash (discard the lock token, let TTL expire or force via time-advance) → re-`acquire_ticket` → assert `recovered_checkpoint.commit_id` matches → `release_ticket`.
- Assertions on the vault state at each stage (files on disk, frontmatter, board markdown byte-exactness).

**What this milestone does NOT cover:** whether an LLM correctly interprets the tool descriptions and SKILL.md. That's a prompt-engineering concern, validated separately via a manual dogfood run (run the real plugin inside Claude Code, dispatch a real task, observe). Not part of CI.

**Done when:** the scripted E2E runs green in CI with no external deps, and a one-paragraph "how to dogfood manually" note lives in `docs/DOGFOOD.md`.

## Dependencies between milestones

```
M1 ─┬─► M2 ─┬─► M3 ─┬─► M4 ─► M5 ─┬─► M6 ─► M7 ─► M9 ─► M10
    │       │       │              │
    │       │       └─► M8 ────────┘
    │       └─── (pure, no deps)
    └─── (scaffold only)
```

Parallel paths: M8 (Jira adapter) can run alongside M5–M7 once M3 is in place. M7 (webpage) can run alongside M8.

## Out of scope for v1 (tracked separately)

- Worktree-aware checkpointing — defer until pi-cc-plugin work surfaces the need.
- Jira webhooks.
- Linear / GitHub Projects adapters.
- Multi-writer coordination (two orchestrators on the same project).
- Multi-adapter configs (one project Jira, another Obsidian, in the same workspace).
