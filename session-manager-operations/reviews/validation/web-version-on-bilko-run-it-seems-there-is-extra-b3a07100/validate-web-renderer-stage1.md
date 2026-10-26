# Validation: web version stage 1

Base: 51eb7ce0 (from PRD notes). Commits: `4c61639b` (apiSurface), `cd9410b5` (remoteIpcDispatch).
Combined diff also contains unrelated plan work (windows paths, blender-artist seed, ready gate); not reviewed here.
Review tools: `/code-review` and `/security-review` not run; self-review of the two new modules.

## ipc-surface-manifest — VERIFIED
- Frozen rows `{ns,method,channel,kind,remote}`: `src/preload/apiSurface.cjs:16-259` (`Object.freeze` at :260), kinds invoke|send|on|on-dynamic, remote read|mutate|deny.
- Two-way drift test with fake electron: `src/preload/__tests__/apiSurface.test.cjs` — passed in the gate run (3 files / 18 tests, with preload-surface and remoteIpcDispatch).
- Deny set: pty:* (:41-48), app:test-fire-hook/pick-directory/reboot-app (:23,:25,:29), clipboard (:215-217), shell:open (:196), schedule:open-folder, plugins install/abort, watchers:add, config:* all deny, updater:* all deny, voice hotkey/recording (setHotkeyConfig, setRecording, onHotkey) deny, webRemote:* deny.
- No behavior change: `git diff <base>..HEAD -- src/preload/index.cjs` is empty. The only main-process files touched in the plan belong to other PRDs (config, files, pty, index.cjs).
- Gate re-run: `vitest run apiSurface preload-surface` pass; `npm run typecheck` pass; `npm run lint` pass.
- Spot-check of `read` rows against main handlers (no hidden writes found):
  files:list/files:read (files.cjs:382,386; home-confined read only), transcript:readRef/buffer (transcripts.cjs:578-582), sessions:load (sessionsStore.cjs:56, read-only), layout:load (layoutStore.cjs:54), agents:list-personas (agentsIpc.cjs:22), macros:list (index.cjs:586), models:catalog (index.cjs:604), memory:list/read (memoryTool.cjs:405-406), schedule:read-log (scheduler.cjs:9847, readFile only), schedule:list-prds (:9885), schedule:get-history (:9889), schedule:health (:9567), schedule:queue-health (:9597), schedule:lint-queue (queueOps.cjs:608, lintAll), telemetry:recent-records (telemetryIpc.cjs:47), opsRetention:preview (opsRetentionSettings.cjs:141, dry-run report), voice:get-hotkey-config (voiceHotkey.cjs:296, in-memory lazy load). 20 checked; none write state beyond lazy cache load.

## remote-ipc-dispatch — VERIFIED
- `captureIpcHandlers` wraps ipcMain.handle, stores channel->handler, delegates to original: `remoteIpcDispatch.cjs:25-33`; `createRemoteIpcDispatcher({surface,handlers,getConfig}).invoke(client,channel,args)`: :54-91.
- Refusals: not_in_surface / denied (:67-68), e2e_not_authenticated unless `client.e2e.state==='authenticated'` (:70-72), mutate_not_allowed unless remoteEnabled && remoteControlEnabled (:73-75), plus disabled when remoteEnabled false (:63); none call the handler. Policy for shared channels uses the strictest row (:36-45).
- Allowed: synthetic event `{sender:null, remoteClientId}` and args spread (:79-81) returns `{ok:true,result}`; thrown error returns `{ok:false,reason:'handler_error',message}` (:82-84).
- `chunkFrames` serialises once, UTF-8-safe split, frames strictly under maxBytes, 50 MB refusal (:96-114); `joinFrames` reverses and validates sequence (:117-126).
- Tests: `__tests__/remoteIpcDispatch.test.cjs` (105 lines) pass in the gate run.
- Gate re-run: `vitest run remoteIpcDispatch apiSurface` pass; typecheck pass.
- Not wired into index.cjs/webRemote.cjs, as specified.

## Findings
### Critical
- none
### Important
- `src/preload/apiSurface.cjs` files:list / files:read are `read`; handlers confine only to $HOME (`files.cjs:72-76,133-136`), so a paired remote can read any home file (`~/.ssh`, `~/.claude/.credentials.json`) with no project-root fence. Stage 2 wiring should add a project-root check, or mark them `mutate`/remote-control tier.
- `config:*`, `webRemote:*` are `deny`; the `read` set also exposes `telemetry:recent-records` and `transcript:readRef`, which can return sensitive content. Acceptable only behind the e2e-authenticated gate.
### Minor
- `remoteIpcDispatch.cjs:63` — kill-switch check happens before the surface check, so an unauthenticated probe of a disabled desktop gets `disabled`, not `not_in_surface`. This matches the intended gate order.
- `remoteIpcDispatch.cjs:73` — `cfg.remoteEnabled === true` in the mutate check is redundant after :63.
- Several metadata-ish handlers are classed `mutate` (app:git-branch, git:status, history:*), which is conservative, as the PRD requires.
