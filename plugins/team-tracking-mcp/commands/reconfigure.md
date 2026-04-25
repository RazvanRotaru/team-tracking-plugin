---
description: Replace the team-tracking-mcp config by re-running the init flow.
---

Re-run init. The existing `./.team-tracking/config.json` is overwritten on save.

```bash
node "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/init/cli.js"
```
