# Validation: web-remote desktop restore

Base `6b6a18cb`; HEAD `cdbc69a3`. Commits: c2039a79 (schemas/e2e), 90b980be, e60ec012 (bridge), ea8d3969 (wiring), d90180d3 (settings UI), cdbc69a3 (docs).
Validator ran with a temporary `node_modules` symlink to the main checkout (removed afterwards; the worktree has none). Scratch TMPDIR, SM_CHAT_CONCURRENCY unset.

Gates re-run (all exit 0): `npm run typecheck`, `npm run lint`, `npm run lint:docs`, and one vitest run over all 7 restored/new specs (112 tests pass).

## wr-restore-schemas-e2e — VERIFIED
- `e2eStateMachine.cjs`: `git show b014cc2^:… | diff` is empty (byte-identical).
- `web-remote-e2e-pinning.test.cjs`: byte-identical to b014cc2^; passes.
- `ipcSchemas.cjs:36,948-959,1140-1190`: sessionSubscribe, WEB_REMOTE_OTP_RE, DEVICE_ID_RE, webRemotePair/RevokeDevice/AuditTail, READ/SAS_GATED_READS/MUTATE/ALLOWED_COMMANDS defined and exported; `ALLOWED_COMMANDS` is the union (:1179).
- `tests/unit/webRemoteCommandSets.spec.ts` present and passes.

## wr-restore-bridge-module — VERIFIED (with caveat, see Important #1)
- `webRemote.cjs` diff vs b014cc2^ is only `claudeHome()` replacing `os.homedir()/.claude` for CONFIG_PATH/AUDIT_LOG_DIR (HEAD helper `lib/schedulerPaths.cjs`). Adaptation is sensible.
- Specs ipc-web-remote, webRemoteAuthGate, webRemoteSasState: identical to b014cc2^ except an added exports test in ipc-web-remote.spec.ts:275-296 (registerRemoteHandlers/attachWindow/init/destroy). All pass.
- KDF labels: `webRemote.cjs:109` `sm-e2e-v1`, `:131` `sm-sas-v1`; phone app `web/remote-app/src/ws.ts:130,182` same labels. Match.
- Relay URLs: `webRemote.cjs:41-43` `https://bilko.run`, `/api/sm-relay`, `wss://bilko.run/projects/session-manager/relay`; phone app `api.ts:8-13` is same-origin bilko.run, REST under `/api/sm-relay`. Consistent.
- Security: `webRemote.cjs:986-990` refuses MUTATE_COMMANDS unless `remoteControlEnabled` (default false, :198); `:997` refuses MUTATE and SAS_GATED_READS unless `_e2e.state === 'authenticated'`; `pushSessionList` (:725-728) returns before sending unless remote enabled and authenticated. Rejections are opaque. Pty write/chat send are both in MUTATE_COMMANDS.

## wr-wire-main-preload — VERIFIED
- `index.cjs`: require :131; `registerRemoteHandlers()` :1100; `attachWindow` in both blocks (:399 reboot, :1460 normal); `init().catch(logged)` :1491; `destroy()` in `runShutdownCleanup` :1604.
- `preload/index.cjs:395-432`: all 10 invoke methods + onStatus/onTokenRevoked/onRevokedAll returning unsubscribe; `api.d.ts` +61 lines; `webRemoteWiring.spec.ts` passes.

## wr-settings-remote-panel — VERIFIED
- `Settings.tsx`: view union gains 'remote', sub-tab `Phone remote` after Telemetry, project-face reset includes 'remote', renders `<SettingsRemote/>`. No nav/palette files in the diff.
- `SettingsRemote.test.tsx` passes (in the 112); typecheck and lint (selectors + hooks) green.
- Not visually verified (GUI is out of scope).

## wr-docs-restored — VERIFIED
- Root `CLAUDE.md` bullet now names `src/main/webRemote.cjs` / Settings → Phone remote; 11,932 bytes vs 11,936 before (≤ 12,000).
- `web-remote/CLAUDE.md` quote updated; `web/remote-app/CLAUDE.md` has no removed/retired statement, so no change needed. `code-map.md` one line added. `lint:docs` green. No other files changed by this PRD.

## Full `npm run test:unit`
Result: **FAIL — 1 genuine failure**, so this acceptance criterion is not met.
- `tests/unit/runtime-deps-allowlist.spec.ts` "ships exactly chokidar, electron, node-pty, zod": `package.json` gained `"ws": "^8.18.0"` in `dependencies` (commit e60ec012), required by `webRemote.cjs:20`. The allowlist spec (added by 0fe57d54, which pruned `ws` along with the web-remote removal) now fails.
- `schedulerMcpServerGateFiles.test.cjs` (7) and `scheduler-gate-shadow.test.cjs` (2–3) fail only because this validator job runs with `SM_SCHEDULER_JOB_SLUG`/`SM_PROC_ROLE`/`SM_SCHEDULER_JOB_MAY_QUEUE` set; with those unset they pass (31/31). These are environmental, not regressions.

## Findings
### Critical
- none
### Important
1. `package.json` `dependencies.ws` vs `tests/unit/runtime-deps-allowlist.spec.ts:34` — the restore added a runtime dependency without updating the deliberate allowlist (and the spec title/comment "Dependencies count stays at 4"). Fix: update the allowlist to include `ws` (the restore genuinely needs it at runtime) and decide on `package-lock.json`. None of the five PRDs listed `package.json` or this spec in `# Files`, so the gap was invisible to their gates. Attributed to wr-restore-bridge-module (e60ec012).
### Minor
- `package.json` change was outside every PRD's `# Files` list.
- `web/remote-app/CLAUDE.md` unchanged (nothing to replace); fine.
- `<path>` stray 0-byte file in the worktree is the known sqlite MCP placeholder, not part of the diff.

## Security review (self-review of combined diff)
Mutate refusal without remote control, and no session data before SAS authentication: confirmed in code (above) and covered by the passing auth-gate/SAS specs. No secrets in the diff. Config paths come from `claudeHome()`; device ids and OTPs are regex-validated by zod. No new `shell: true`. Live phone pairing was not tested (out of scope).
