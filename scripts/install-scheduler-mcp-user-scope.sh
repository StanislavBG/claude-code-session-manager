#!/bin/bash
# install-scheduler-mcp-user-scope.sh — Idempotent installer for the
# session-manager-scheduler MCP server at USER scope (~/.claude.json).
#
# Why user scope: session-manager-scheduler is a machine-wide service (it
# talks to the session-manager Electron app's loopback admin API, not
# anything project-specific). Registering it per-project in each repo's own
# .mcp.json is the wrong shape — it has to be re-added to every new project,
# and a project whose .mcp.json omits it silently loses access to
# scheduler_create_prd with no error (the tool is just absent from the
# agent's tool list). See PRD 1024-1030 incident: social-signals-trader
# hand-wrote 7 PRDs to disk because the tool wasn't in its list, not because
# the tool errored.
#
# This does NOT remove any project's existing .mcp.json entry for
# session-manager-scheduler — user scope is additive, so projects that
# already register it per-project keep working during rollout.
#
# Usage:
#   bash scripts/install-scheduler-mcp-user-scope.sh
#
# Safe to re-run: `claude mcp add` overwrites only the named server's own
# entry, leaving every other user-scope server (fetch, sqlite, playwright,
# google-workspace, n8n, ...) untouched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_JS="$REPO_DIR/scripts/scheduler-mcp-server.cjs"

if [ ! -f "$SERVER_JS" ]; then
    echo "ERROR: $SERVER_JS not found." >&2
    exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
    echo "ERROR: 'claude' CLI not found on PATH." >&2
    exit 1
fi

echo "Registering session-manager-scheduler at user scope (absolute path: $SERVER_JS)..."
claude mcp remove session-manager-scheduler --scope user >/dev/null 2>&1 || true
claude mcp add session-manager-scheduler --scope user -- node "$SERVER_JS"

echo "Done. Verify with: claude mcp list"
