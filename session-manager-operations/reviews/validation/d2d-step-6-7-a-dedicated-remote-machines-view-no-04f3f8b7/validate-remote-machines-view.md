# Validation: remote-machines-view plan (PRDs 1789–1796)

Base: `8b2230ba` (HEAD `097c07fa`). PRD files found in `prds-archived/` (1792 and 1793 also have `*-fix-*` follow-ups archived beside them).

Gates were re-run from the main checkout (`/home/bilko/Projects/session-manager`, same HEAD `097c07fa`, clean tree) because this job worktree has no `node_modules`. Scratch TMPDIR; only the named test files were run.
- `npx vitest run` over webRemoteAgentReads, webRemoteEpicList, remoteClient.test.cjs, `components/remote/`, RemoteMachines.test.tsx, navGroupsHome, layout → **11 files, 189 tests passed**.
- `npm run typecheck` → exit 0. `npm run lint` → exit 0 (includes `lint:page-stewards` clean).

## 1789 remote-agent-info-and-session-list — VERIFIED
- `src/main/ipcSchemas.cjs:1158-1171`: `cmd:app:info` in READ_COMMANDS with justification comment; `cmd:sessions:list` in SAS_GATED_READS.
- `src/main/webRemote.cjs:1166`: returns only `{ version, platform }`.
- `src/main/webRemote.cjs:1094-1101`: `{ sessions: buildRemoteSessionList(tabs, readActiveIndex), activeTabId ?? null }`.
- `tests/unit/webRemoteAgentReads.spec.ts` present and passing. Gate green.

## 1790 remote-client-peer-os — VERIFIED
- `src/main/remoteClient.cjs:103` `os: null` on addPeer; `:121-130` `learnOs` fires `cmd:app:info` once on `markAuthenticated`, persists string `platform`, swallows rejection.
- `src/preload/api.d.ts:1620` `os: string | null`.
- remoteClient.test.cjs passes (win32 persisted / rejection / survives disconnect). Gate green.

## 1791 remote-peers-hook-primitive — VERIFIED
- `useRemotePeers.ts` exists; `RemoteMachinesSection.tsx` consumes it; `useRemotePeers.test.tsx` and RemoteMachinesSection tests pass. Gate green.

## 1792 remote-sessions-panel-grouped — VERIFIED
- `RemoteSessionsPanel.tsx:56` `cmd:sessions:list`, `:60` fallback `cmd:sessions:load`, `:103` `cmd:chat:send` with tabId, `:131` group testid, `:142-143` terminal button gated on `onOpenTerminal`. Tests pass. Gate green.

## 1793 remote-machines-view — VERIFIED
- `tabs/RemoteMachines.tsx`: `remote-view-empty`/`-open-settings` (:61-62), `OS_LABELS` + 'OS unknown' (:14-15), `remote-view-machine` (:31), header + header-badge (:87-89), `remote-view-offline` (:102), tab testids (:130), Sessions panel with `onOpenTerminal` (:142) and RemoteTerminalPanel (:144). RemoteMachines.test.tsx passes. Gate green.

## 1794 remote-nav-entry — VERIFIED
- `navKey.ts:28`, `screenKeys.ts:21`, `navGroups.ts:69` (Workspace, HOME faces, hint as specified), `screenComponents.tsx:61,133` (onOpenSettings → `ctx.onNavigate?.('settings')`), `.claude/agents/page-remote.md` present, `lint:page-stewards` clean, navGroupsHome/layout tests pass. Gate green.

## 1795 settings-remote-links-remote-view — VERIFIED
- `RemoteMachinesSection.tsx`: no references to RemoteTerminalPanel / RemoteSessionsPanel / `remote-machine-terminal` / `remote-machine-sessions`; `:201` `useLayout(openPanel)`, `:228` `remote-machines-open-view` → `openPanel('remote')`. Tests pass. Gate green.

## 1796 remote-view-screenshot-spec — VERIFIED (read-only; Playwright/Electron NOT run)
- `tests/e2e/remote-view.spec.ts`: `ipcMain.removeHandler` then `handle` for `remoteClient:list/connect/send` (:57-), fake `cmd:pty:spawn` pushes `event:pty:data` over `remoteClient:event` (:67-72), asserts `remote-view-empty` (:90), `remote-view-offline` + header badge (:99-100), `remote-terminal-panel`/`-badge`/header badge with machine name/`-host` output (:106-109); `shoot()` writes `{empty,offline,online-terminal}-{light,dark}.png` (:29).
- Typecheck + lint green.
- **Pending human step:** the six screenshots (`test-results/remote-view/remote-{empty,offline,online-terminal}-{light,dark}.png`) have not been produced; a human must run the spec.

## Findings
### Critical
- none
### Important
- none
### Minor
- `tests/e2e/remote-view.spec.ts:27` switches light/dark with `win.emulateMedia({ colorScheme })`, not the app's own theme toggle as the AC says ("existing theme toggle mechanism"). If the app theme is user-selected rather than `prefers-color-scheme`-driven, the light and dark shots may be identical. Check when the human runs it.
- The combined `git diff <base>..HEAD` (84 files) includes unrelated sibling plans (auto-updater, p2p proposal card, multi-client agent, remote new-session). Only the paths above were reviewed against this plan; no secrets, path traversal or unsafe input handling seen in them. `cmd:app:info` leaks only semver + platform, and `cmd:sessions:list` is SAS-gated.
- `/code-review` and `/security-review` were not run as separate passes; self-review of the plan's diff only.
