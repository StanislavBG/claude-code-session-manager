#!/usr/bin/env bash

# Session Manager project health check.
# Thin wrapper over src/main/health.cjs, the real runtime health check
# (app startup, scheduler stall detection, watcher liveness, etc.) — this
# script used to shadow it with its own multi-minute e2e-running checks,
# turning /local-project-health into a build gate instead of a status read.
# That old behaviour has been dropped entirely, not preserved behind a flag:
# health.cjs's checks supersede it (scheduler/queue health, not just
# typecheck/build/e2e), so there is nothing left worth gating behind
# SM_FULL_HEALTH.

set -eu
cd "$(dirname "$0")/.."

exec node src/main/health.cjs "$@"
