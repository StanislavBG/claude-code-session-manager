#!/bin/bash
# installer-idempotent.sh — AC test for install-scheduler-watchdog.sh dry-run.
#
# Verifies:
#   1. First dry-run emits non-empty unit/cron text.
#   2. Second dry-run output is byte-identical (idempotent).
#   3. The output references scripts/scheduler-watchdog.sh.
#
# Expected runtime: well under 60 s (bash-only, no network, no live timer).
# Run: timeout 60 bash scripts/__tests__/installer-idempotent.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALLER="$REPO_DIR/scripts/install-scheduler-watchdog.sh"
WATCHDOG_SH="scripts/scheduler-watchdog.sh"

PASS=0
FAIL=0

ok()   { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo "=== installer-idempotent: testing $INSTALLER ==="
echo ""

# ---------------------------------------------------------------------------
# 1. Installer script parses without errors (bash -n).
# ---------------------------------------------------------------------------
if bash -n "$INSTALLER" 2>/dev/null; then
    ok "bash -n parses clean"
else
    fail "bash -n reported a syntax error"
fi

# ---------------------------------------------------------------------------
# 2. Dry-run emits non-empty output.
# ---------------------------------------------------------------------------
RUN1="$(SM_WATCHDOG_DRYRUN=1 bash "$INSTALLER" 2>/dev/null)"
if [ -n "$RUN1" ]; then
    ok "first dry-run produced output (${#RUN1} bytes)"
else
    fail "first dry-run produced no output"
fi

# ---------------------------------------------------------------------------
# 3. Second dry-run is byte-identical (idempotent).
# ---------------------------------------------------------------------------
RUN2="$(SM_WATCHDOG_DRYRUN=1 bash "$INSTALLER" 2>/dev/null)"
if [ "$RUN1" = "$RUN2" ]; then
    ok "second dry-run is byte-identical (idempotent)"
else
    fail "second dry-run differs from first"
    echo "--- first run (first 200 chars) ---"
    echo "${RUN1:0:200}"
    echo "--- second run (first 200 chars) ---"
    echo "${RUN2:0:200}"
fi

# ---------------------------------------------------------------------------
# 4. Output references scripts/scheduler-watchdog.sh (absolute path).
# ---------------------------------------------------------------------------
if echo "$RUN1" | grep -qF "$WATCHDOG_SH"; then
    ok "output references $WATCHDOG_SH"
else
    fail "output does not reference $WATCHDOG_SH"
    echo "  Output snippet: $(echo "$RUN1" | head -5)"
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
