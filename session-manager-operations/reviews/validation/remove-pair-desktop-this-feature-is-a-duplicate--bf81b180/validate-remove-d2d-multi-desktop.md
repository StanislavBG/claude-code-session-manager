# Validation — remove desktop-to-desktop, multi-desktop web remote

Base: 24f3e58e (found in PRD notes). Combined diff `24f3e58e..HEAD`: 81 files, +1350/−4138.
Gates re-run (all exit 0): `npm run typecheck`, `npm run lint` (incl. page-stewards, e2e-budget),
full root `npx vitest run` with SM_* unset (808 files / 7585 passed, 1 skipped),
`npm --prefix web/remote-app ci` + `typecheck` + `test` (27 files / 175 tests), `lint:docs`, `manual:check`.
Per-PRD gates are subsets of these commands (the targeted vitest lists are covered by the full run).
All 14 PRD files found under `prds-archived/` (2278 archived too). No missing files.

## Per-PRD verdicts

- **remove-remote-machines-renderer — VERIFIED.** `ls` confirms RemoteMachines*/RemoteSessionsPanel/RemoteTerminalPanel/useRemotePeers, their tests, remote-view.spec.ts and `.claude/agents/page-remote.md` are gone; `remoteUi.tsx` kept. Diff removes 'remote' from navKey.ts, screenKeys.ts, navGroups.ts, screenComponents.tsx, learningContent.ts; SettingsRemote.tsx −Remote machines section. Grep of src/renderer for the removed identifiers: clean (only a stale comment, Minor 1). Typecheck/lint green.
- **agent-drop-remote-pty-control — VERIFIED.** webRemote.cjs diff removes cmd:pty:spawn/write/resize/kill, stopClientPtyStream, cmd:sessions:load/save/list, buildRemoteSessionList; ipcSchemas.cjs drops them from MUTATE/SAS sets; tests/unit/ipc-web-remote.spec.ts:53 asserts no `cmd:pty:*` allowlisted. Suite green.
- **remote-app-drop-desktop-clients — VERIFIED.** DesktopClientsPanel.tsx, its spec and api.ts/types.ts client-endpoint code deleted; ConnectScreen/Cockpit updated; web/remote-app typecheck+tests green.
- **remote-app-devices-module — VERIFIED.** web/remote-app/src/devices.ts (pickActiveDevice, preferred/meta localStorage, labels) + devices.spec.ts (115 lines) pass.
- **remote-app-pair-code-component — VERIFIED.** components/PairCode.tsx extracted from ConnectScreen; pair-code.spec.tsx passes.
- **remove-remote-client-main — VERIFIED.** src/main/remoteClient.cjs, remoteClientIpc.cjs, relayClientAuth.cjs and their tests are gone (`ls src/main/remoteClient*` → no match); index.cjs, preload index.cjs/api.d.ts de-wired; typecheck+lint green.
- **pty-drop-output-listeners — VERIFIED.** pty.cjs −53 lines (addOutputListener) and pty-output-listeners test removed; no remaining reference (grep clean); pty-output-batching passes in full run.
- **remote-app-store-per-device — VERIFIED.** store.ts adds readyDeviceIds, per-device markRemoteReady/clearRemoteReady, chooseDevice, deviceMeta; setActiveDevice resets route/stateByTab/pendingSas/refreshKey. store.spec.ts +89 lines passes.
- **agent-allowlist-web-app-only — VERIFIED.** ipcSchemas.cjs READ={session:unsubscribe}, SAS_GATED includes app:info/session:subscribe/options/projects:list/project:sessions/session:transcript/session:prds, MUTATE={chat:send,session:create}. Set of `cmd:*` literals used by web/remote-app/src (10) equals the allowlist exactly. app:info now returns hostname and is SAS-gated (webRemote.cjs).
- **remote-app-multi-desktop-wiring — VERIFIED.** App.tsx: active desktop kept stable (pickActiveDevice), E2E initiated only for the active device, session:state and sas:pending filtered by `m.deviceId === activeDeviceId`, ready tracked per device, names learned via getAppInfo; multi-device.spec.tsx passes.
- **remote-app-connect-screen-desktops — VERIFIED.** ConnectScreen lists desktop names/OS and opens online desktops; connect-screen-copy/offline specs updated and pass.
- **agent-retire-desktop-client-identity — VERIFIED.** webRemote.cjs: `pruneDesktopPins` (drops pins with string clientId, strips clientId), `removeOrphanedClientFiles` (remote-peers.json, relay-client.json), clientId removed from audit/status/addPinnedPeerKey; web-remote-retire-d2d.test.cjs (75 lines) passes. Follow-up commit 060b2404 fixed non-object pin passthrough.
- **remote-app-device-switcher — VERIFIED.** components/DevicePicker.tsx + header switcher in Cockpit.tsx; device-picker.spec.tsx (4 tests) passes.
- **docs-web-remote-multi-desktop — VERIFIED.** web/remote-app/CLAUDE.md +3 lines, manual cockpit-tour.html teaches multi-desktop and drops "Remote machines"; manual.json updated; `lint:docs` and `manual:check` exit 0.

(Extra PRDs 2283/2284 not in scope; their commits 6750c8a8 and 060b2404 are consistent with the above.)

## Combined-diff review

- **Remote command surface (security):** strictly shrunk. Allowlist = exactly the web app's 10 commands; no PTY control, no sessions:save, no history:aggregate, no app:version. Hostname exposure is SAS-gated. Mutations remain behind remoteControlEnabled + SAS. No new input parsing introduced; no secrets or paths from remote input reach fs. `removeOrphanedClientFiles` uses fixed filenames under claudeHome (no traversal).
- **Leftover d2d references:** repo-wide grep (excluding reviews/, design-mocks/, node_modules) finds only: negative assertions in tests/unit/ipc-web-remote.spec.ts; web-remote/relay/tests/router.spec.ts using `cmd:pty:write` as an opaque test payload (relay, unaffected); `remoteClientSessions.cjs` (the per-client E2E registry — legitimately kept for multi-browser, name is historical); retire-d2d test; two stale comments (Minor).
- **Multi-desktop state isolation:** per-device ready set, per-device meta key (`sm-device-meta-v1-<id>`), switch clears tab state/route/SAS, event handlers filter by active deviceId, E2E negotiated only with the active desktop. Pins on the desktop side are per-peer-pubkey. No cross-device leakage found.

## Findings

Critical: none.
Important: none.
Minor:
1. src/renderer/components/remote/remoteUi.tsx:4 — comment still says "and the Remote machines section".
2. src/main/webRemote.cjs:71 — comment still says "shared with the desktop client role".
3. src/main/ipcSchemas.cjs:1257-1258 — comment "a mutation, a mutation." awkward after edit.
4. ptySpawn/ptyWrite/ptyResize schemas remain exported and are only exercised by pty IPC and unit tests of "cmd:pty:*" payloads (tests/unit/ipc-web-remote.spec.ts:149-175) — those test titles are misleading but the schemas are still used by pty.cjs:434.
