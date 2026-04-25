# team-tracking-plugin

<img width="1920" height="638" alt="image" src="https://github.com/user-attachments/assets/95c79d47-9668-411b-b163-9849629d2c96" />

A Claude Code plugin that gives an orchestrator and its specialist subagents a shared, durable view of the work they're driving. Tickets live in your real tracker (Obsidian Kanban or Jira); the plugin's MCP server is the contract between Claude and the board.

See [`examples/`](examples/) for a browseable snapshot of an orchestrator-driven board.

## What it ships

- **MCP server** exposing ten tools: `list_board`, `get_ticket`, `list_children`, `create_ticket`, `update_ticket`, `acquire_ticket`, `commit_checkpoint`, `release_ticket`, `report_progress`, `append_log`.
- **Two adapters today**: Obsidian Kanban (file-backed, local vault) and Jira (cloud, with custom-field or fenced-section storage).
- **Slash commands**: `/team-tracking:init`, `/team-tracking:status`, `/team-tracking:reconfigure`.
- **Three skills** that teach Claude how to use the system:
  - [`team-tracking-orchestrate`](skills/team-tracking-orchestrate/SKILL.md) — for the planner: read the board, decompose, pick priorities, consult the architect, dispatch.
  - [`team-tracking-execute`](skills/team-tracking-execute/SKILL.md) — for specialist subagents: acquire → checkpoint → release, plus how to escalate when a subtask is too complex.
  - [`team-tracking-usage`](skills/team-tracking-usage/SKILL.md) — tool reference (the ten tools, lock state machine, typed errors).

## Install

Requires Node 20+ and pnpm 10+.

```bash
git clone https://github.com/RazvanRotaru/team-tracking-plugin.git
cd team-tracking-plugin
pnpm install
pnpm build
```

Register the plugin from inside a Claude Code session:

```
/plugin install /absolute/path/to/team-tracking-plugin
```

(Path-based install from the local checkout. `pnpm build` must have produced `mcp-server/dist/` first — `plugin.json` points the MCP server at `mcp-server/dist/index.js`.)

## Configure

In any project where you want an orchestrator to use the plugin:

```
/team-tracking:init
```

This launches a token-protected localhost page. Pick Obsidian Kanban or Jira, fill in the form, and the config lands at `./.team-tracking/config.json`. The MCP server reads it on session boot; `/team-tracking:status` confirms what's wired.

For scripted setup (CI, dotfiles), the same flow runs headlessly:

```bash
node mcp-server/dist/init/cli.js \
  --adapter obsidian-kanban --vault ./vault --project Autopilot
```

## Try the demo

A pre-populated example vault is committed under [`examples/demo/`](examples/), so you can see what an orchestrator-driven board looks like without configuring anything. Each ticket is plain markdown — the layout is browseable directly on GitHub.

To regenerate it locally (or build it at a different path so the working tree stays clean):

```bash
pnpm demo                     # writes to ./examples/demo
pnpm demo ~/scratch/board     # any path
```

To open it as a real kanban: in Obsidian, **File → Open vault → `examples/demo`**, install the community **Kanban** plugin, then open `projects/Demo/board.md`.

## Repo layout

```
team-tracking-plugin/
  .claude-plugin/plugin.json    # plugin manifest registered with Claude Code
  commands/                     # /team-tracking:* slash commands
  skills/team-tracking-usage/   # orchestrator-facing skill
  mcp-server/
    src/
      domain/                   # pure types, invariants, lock state machine
      adapters/                 # TrackerAdapter + obsidian-kanban + jira
      server/                   # per-ref mutex, TicketService, MCP tools
      config/, init/            # config loader + init CLI / webpage
    scripts/populate-demo.mjs   # demo content generator
  scripts/setup-demo.sh         # `pnpm demo` entrypoint
  examples/demo/                # committed example vault
  docs/DOGFOOD.md
```

## Development

```bash
pnpm typecheck
pnpm test           # ~140 tests, including a stdio MCP e2e
pnpm lint
```

CI runs typecheck + build + test + lint on every push.
