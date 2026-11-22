# Validation: login-item-script-ownership-and-refresh (PRD 3531)

Base: 81fda522. Commit: ac15075a (only commit touching the PRD's files). Verdict: **VERIFIED**

## Criteria evidence
- SCRIPT_MARKER exported and used by the script text: loginItemPlan.cjs:12 (const), :78 (`SCRIPT_MARKER` in startScript), :193 (export).
- setEnabled on/off refuse a foreign script: loginItem.cjs refuseForeign checks `scriptCarriesMarker(readOrNull(p.scriptPath))` and throws an Error naming `p.scriptPath` before any write/remove (entry included). Tests "switch-on leaves it alone and names it", "switch-off leaves it and the entry alone and names it".
- status() with foreign script: loginItem.cjs statusOf, `${p.scriptPath} was not written by Session Manager.`, enabled=false. Test "status reads as off with a reason naming the script".
- refreshIfStale: loginItem.cjs (added after setEnabled) compares entryText/scriptText, writes both via `writeTextAtomic`, returns true/false, try/catch logs through `warn`, returns false. Exported from createLoginItem.
- index.cjs: `void loginItem.refreshIfStale();` once after registerLoginItemPlan IPC registration, not awaited; `warn` wired to logs.
- Tests present: foreign script on/off, status foreign, stale script, stale entry, older npx path, up-to-date untouched, off does nothing, foreign never throws.

## Extra code-reading check
- Cannot create a login item that was off: refreshIfStale returns false unless `statusOf(p).enabled`, which requires an existing entry with our marker, not switched off, plus a present, marker-carrying script (npx). Missing, foreign, or hand-disabled entries return false before any write. The electron-login-item mechanism and unsupported platforms return early.
- Nothing is spawned: the only calls are readOrNull and writeTextAtomic; no child_process in the path.
- Nothing was written under ~/.config/autostart or ~/.claude/session-manager during this validation (tests use temp homes).

## Gate (re-run)
- vitest loginItem, loginItemPlan, loginItemIpc: 3 files, 36 tests passed.
- `npm run lint`: exit 0. `npm run typecheck`: clean.
- Slash commands /code-review and /security-review were not run; self-reviewed the diff for correctness, path handling, secrets, unsafe input: no issues (paths come from the plan, mode 0o700 on script, atomic writes).

## Findings
- Critical: none
- Important: none
- Minor: none
