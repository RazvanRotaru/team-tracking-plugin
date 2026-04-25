#!/usr/bin/env bash
# Build the mcp-server and create a fresh team-tracking demo vault.
#
# Usage:
#   scripts/setup-demo.sh [target-path]
#
# Default target: ./examples/demo (vault committed in the repo so the
# layout is browseable on GitHub). Pass a custom path (e.g. ~/scratch/board)
# to keep your working tree clean.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$REPO_ROOT/examples/demo}"

mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

echo "→ build mcp-server"
(cd "$REPO_ROOT" && pnpm build >/dev/null)

echo "→ reset prior demo state under $TARGET"
rm -rf "$TARGET/projects" "$TARGET/.team-tracking"

PLUGIN_ROOT="$REPO_ROOT/plugins/team-tracking-mcp"

echo "→ write team-tracking config (vault=$TARGET, project=Demo)"
cd "$TARGET"
node "$PLUGIN_ROOT/mcp-server/dist/init/cli.js" \
  --adapter obsidian-kanban \
  --vault "$TARGET" \
  --project Demo \
  --no-gitignore >/dev/null

echo "→ populate sample tickets"
node "$PLUGIN_ROOT/mcp-server/scripts/populate-demo.mjs" >/dev/null

cat <<EOF

demo vault ready: $TARGET
  board:    $TARGET/projects/Demo/board.md
  tickets:  $TARGET/projects/Demo/tickets/

open in Obsidian: File → Open vault → $TARGET
EOF
