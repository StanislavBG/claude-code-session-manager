#!/bin/bash
# install-scheduler-watchdog.sh — Idempotent installer for the scheduler watchdog.
#
# Registers scheduler-watchdog.sh as a systemd user timer (preferred) or cron
# entry (fallback) so the watchdog runs every 2–3 min independent of Electron.
#
# Usage:
#   bash scripts/install-scheduler-watchdog.sh          # install
#   SM_WATCHDOG_DRYRUN=1 bash scripts/install-scheduler-watchdog.sh  # print unit/cron to stdout only
#
# Mirrors the cron+flock idempotency pattern from:
#   /home/bilko/Projects/burrow/scripts/mcp-keepalive.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve absolute paths — required so units work with no cwd assumption.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCHDOG_SH="$REPO_DIR/scripts/scheduler-watchdog.sh"
WATCHDOG_LOG="$REPO_DIR/logs/scheduler-watchdog.log"

if [ ! -f "$WATCHDOG_SH" ]; then
    echo "ERROR: $WATCHDOG_SH not found. PRDs 99–102 must be merged first." >&2
    exit 1
fi

DRYRUN="${SM_WATCHDOG_DRYRUN:-0}"

# ---------------------------------------------------------------------------
# systemd user unit templates.
# ---------------------------------------------------------------------------
SERVICE_NAME="scheduler-watchdog"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SYSTEMD_DIR/${SERVICE_NAME}.service"
TIMER_FILE="$SYSTEMD_DIR/${SERVICE_NAME}.timer"

SERVICE_CONTENT="[Unit]
Description=Claude Code session-manager scheduler watchdog
After=network.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${WATCHDOG_SH}
StandardOutput=append:${WATCHDOG_LOG}
StandardError=append:${WATCHDOG_LOG}

[Install]
WantedBy=default.target
"

TIMER_CONTENT="[Unit]
Description=Run scheduler-watchdog every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
Persistent=true

[Install]
WantedBy=timers.target
"

# ---------------------------------------------------------------------------
# Cron fallback template.
# scheduler-watchdog.sh already uses internal flock -n; no outer flock here
# to avoid double-lock contention (outer flock execs bash which then inherits
# the lock fd, causing the internal subshell flock to see the file as locked
# and no-op every run).
# ---------------------------------------------------------------------------
CRON_LINE="*/3 * * * * /bin/bash ${WATCHDOG_SH} >> ${WATCHDOG_LOG} 2>&1"

# ---------------------------------------------------------------------------
# Detect whether systemd user session is available.
# ---------------------------------------------------------------------------
has_systemd_user() {
    systemctl --user status > /dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Install via systemd user timer.
# ---------------------------------------------------------------------------
install_systemd() {
    if [ "$DRYRUN" = "1" ]; then
        echo "# --- ${SERVICE_NAME}.service ---"
        printf '%s' "$SERVICE_CONTENT"
        echo ""
        echo "# --- ${SERVICE_NAME}.timer ---"
        printf '%s' "$TIMER_CONTENT"
        return
    fi

    mkdir -p "$SYSTEMD_DIR" "$(dirname "$WATCHDOG_LOG")"

    # Write units (idempotent — same content on re-run).
    printf '%s' "$SERVICE_CONTENT" > "$SERVICE_FILE"
    printf '%s' "$TIMER_CONTENT" > "$TIMER_FILE"

    systemctl --user daemon-reload
    systemctl --user enable --now "${SERVICE_NAME}.timer"

    echo "[install-scheduler-watchdog] systemd timer installed and started."
    echo ""
    echo "  Unit files:"
    echo "    $SERVICE_FILE"
    echo "    $TIMER_FILE"
    echo ""
    echo "  Verify:  systemctl --user list-timers ${SERVICE_NAME}.timer"
    echo "  Logs:    journalctl --user -u ${SERVICE_NAME}.service -f"
    echo "           $WATCHDOG_LOG"
    echo ""
    echo "NOTE: user timers only run while you are logged in."
    echo "  To keep the watchdog alive after logout (e.g. for headless servers):"
    echo "    loginctl enable-linger \"$USER\""
}

# ---------------------------------------------------------------------------
# Install via cron (fallback when systemd --user is unavailable).
# ---------------------------------------------------------------------------
install_cron() {
    if [ "$DRYRUN" = "1" ]; then
        echo "# --- crontab entry ---"
        echo "$CRON_LINE"
        return
    fi

    mkdir -p "$(dirname "$WATCHDOG_LOG")"

    # Idempotent: only append if the watchdog is not already in the crontab.
    if crontab -l 2>/dev/null | grep -qF "scheduler-watchdog.sh"; then
        echo "[install-scheduler-watchdog] cron entry already exists — no change."
    else
        (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
        echo "[install-scheduler-watchdog] cron entry added."
        echo "  $CRON_LINE"
    fi

    echo ""
    echo "  Logs: $WATCHDOG_LOG"
    echo ""
    echo "NOTE: user timers only run while you are logged in."
    echo "  To keep the watchdog alive after logout (e.g. for headless servers):"
    echo "    loginctl enable-linger \"$USER\""
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
if has_systemd_user; then
    install_systemd
else
    echo "[install-scheduler-watchdog] systemctl --user unavailable — falling back to cron." >&2
    install_cron
fi
