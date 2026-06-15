#!/bin/bash
# scheduler-watchdog.sh — flock wrapper for scheduler-watchdog.cjs.
#
# Designed to be called from a systemd user timer or cron. flock -n ensures
# overlapping timer ticks skip cleanly rather than pile up.
# Mirrors the cron+flock pattern from /home/bilko/Projects/burrow/scripts/mcp-keepalive.sh.
#
# Install example (systemd user timer — see PRD 103):
#   systemctl --user start sm-scheduler-watchdog.timer

set -e

# Timers run with a minimal PATH — export the same set used by mcp-keepalive.sh
# so node and npm-global CLIs resolve correctly.
export PATH="/home/bilko/.local/bin:/home/bilko/.npm-global/bin:/home/bilko/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin"

# Resolve repo dir from this script's own location so it works from a timer
# with no cwd assumption.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK="/tmp/sm-scheduler-watchdog.lock"

(
    exec 200>"$LOCK"
    if ! flock -n 200; then
        echo "[$(date -Iseconds)] [watchdog] another tick is running — skipping"
        exit 0
    fi

    exec node "$REPO_DIR/scripts/scheduler-watchdog.cjs" "$@"
)
