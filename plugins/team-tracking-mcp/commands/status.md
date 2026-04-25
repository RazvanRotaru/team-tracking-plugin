---
description: Print the current team-tracking-mcp configuration (adapter, projects, lock TTL).
---

Read `./.team-tracking/config.json` and report the configured adapter and projects. If no config exists, the MCP tools will refuse with `ENOTCONFIGURED` until `/team-tracking:init` is run.

```bash
if [ -f ./.team-tracking/config.json ]; then
  echo "team-tracking config: ./.team-tracking/config.json"
  cat ./.team-tracking/config.json | python3 -m json.tool 2>/dev/null \
    || cat ./.team-tracking/config.json
else
  echo "team-tracking is not configured. Run /team-tracking:init"
fi
```
