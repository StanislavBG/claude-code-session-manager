# Validation: seed-status-agent-personas-done (PRD 3061)

Base: 9c4b6be8. Commits since base touching the PRD's paths: b073df1a (only commit).
PRD file found at scheduler/epics/.../prds-archived/3061-seed-status-agent-personas-done.md.

## seed-status-agent-personas-done — VERIFIED

Evidence per criterion:
1. `markerStatus()` exported (src/main/seedAgentPersonas.cjs ~130-151, `module.exports` has `markerStatus`): seeded array → `PERSONAS.every(...)` → 'done' regardless of attempts; else >= MAX_ATTEMPTS 'exhausted', >0 'failed', else 'pending'. Probe confirmed done / failed.
2. Legacy: no `seeded` array → `Boolean(m.done)`; same attempts rule; whole body in try/catch returning 'pending' (absent/unparseable). Parses the raw file, not readMarker().
3. src/main/seedStatus.cjs getSeedStatus: `typeof mod.markerStatus === 'function' ? mod.markerStatus() : statusFromMarker(mod)`; return shape `{status, fix}` unchanged; dev-plugin/scheduler-mcp have no markerStatus so use the default reader. statusFromMarker comment updated.
4. seedStatus.test.cjs adds the 5 cases from real `PERSONAS` (done/done/pending/failed/exhausted); diff is append-only, so existing tests are unchanged.
5. Wiring test deletes SM_SEED_AGENT_PERSONAS_DISABLE, runs real `seedAgentPersonas({logger})`, asserts 'done' (restores env in finally).

Gate re-run: 5 files / 96 tests passed; `npm run typecheck` exit 0.

## Real-reader probe
`env -i HOME=<fresh tmp>` node script outside repo, requiring both modules by absolute path:
- after `await seedAgentPersonas({logger})`: `getSeedStatus()['agent-personas'].status` = `done`
- after rewriting marker to `{seeded:['architect'],attempts:1}`: `failed`.
Both as required.

## Full unit suite
`npx vitest run` with all SM_* and CLAUDECODE unset: 1042 files passed, 10143 tests passed, 1 skipped, 0 red. No flake/regression to name.

## Review
/code-review and /security-review not run as separate commands; self-reviewed the 3-file, 75-line diff: reads one fixed path under HOME, no input from outside, no secrets, no path traversal, no duplicated helper.

## Findings
- Critical: none
- Important: none
- Minor: src/main/seedStatus.cjs:58 — the new ternary line is long (~150 chars); cosmetic only.
