# Dogfooding team-tracking-mcp inside Claude Code

CI exercises the protocol via a scripted MCP client (see `mcp-server/src/server/e2e.test.ts`). That covers wire-level correctness but not whether an LLM correctly interprets the tool descriptions and `team-tracking-usage` skill. To validate that, run the plugin manually:

1. `pnpm build` from the repo root.
2. From a target project, install the plugin: `claude plugin install /path/to/team-tracking-plugin`.
3. Run `/team-tracking:init` and complete the webpage flow against a temp Obsidian vault.
4. In a Claude Code session, ask the orchestrator to take a small PRD and decompose it via the plugin (e.g. "Use team-tracking to create an epic with two subtasks for the following PRD:..."). Watch the resulting tool calls.
5. Trigger the retry path: kill a subagent mid-run, wait past the configured `lockTtlSeconds`, and verify the orchestrator picks up the recovered checkpoint and dispatches a retry that consults the prior `progress_summary`.

If steps 4–5 succeed without hand-holding, the prompt surface is good. If the orchestrator misuses a tool (wrong order, missing `lock_token`, ignoring `recovered_checkpoint`), the fix lives in `skills/team-tracking-usage/SKILL.md` or in tool descriptions in `mcp-server/src/server/tools.ts`, not in code.
