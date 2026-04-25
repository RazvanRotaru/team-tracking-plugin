---
description: Configure team-tracking-mcp for the current project (Jira or Obsidian Kanban).
---

Run the team-tracking-mcp init flow. Spawns a local HTTP server, opens a browser to a token-protected URL, and writes the chosen config to `./.team-tracking/config.json`.

If the project is a git repo, `.team-tracking/` is appended to `.gitignore` automatically.

```bash
node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/init/cli.js"
```

To run headlessly (CI / scripts) instead, pass adapter args:

```bash
# Obsidian
node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/init/cli.js" \
  --adapter obsidian-kanban --vault ./vault --project Acme

# Jira
node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/init/cli.js" \
  --adapter jira \
  --jira-base-url https://acme.atlassian.net \
  --jira-email you@acme.com --jira-api-token "$JIRA_API_TOKEN" \
  --project Acme --project-ref ACME
```
