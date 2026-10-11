# Validation: agent accepts several E2E clients at once (PRD 1788)

Base: no `Base:` line in the PRD; base inferred as `1e103cab` (last commit before the first plan commit `7ba79e2e`). Head `cd44aa9b`.
Environment note: the job worktree has no `node_modules`; I symlinked the main checkout's (gitignored) so gates could run. Relay half is out of scope per PRD.

## Gates (merged tree)
- `vitest run remoteClientSessions / web-remote-multi-client / web-remote-pty-stream / web-remote-e2e-pinning` → 4 files, 21 tests passed.
- `npm run typecheck` → exit 0.
- Extra PRD gates: `vitest run tests/unit/webRemote{AuthGate,SasState,CommandSets,Wiring,EpicList}.spec.ts ipc-web-remote.spec.ts` → 6 files, 110 passed. `npm run lint` → exit 0.

## mc-client-session-registry — VERIFIED
- Exports `createClientSessions` with all 10 methods: `src/main/lib/feedback-remote/remoteClientSessions.cjs:55-79`.
- `clientKeyOf` → fromConn if non-empty string ≤64 else 'legacy' (`LEGACY_CLIENT_KEY` exported): :20-24, :84.
- Record shape (key, clientId, e2e=makeState(), peerPubKey null, deviceId null, ptyStreams Map, subscriptions Set, lastSessionListJson null): :27-38.
- teardown swallows unsub throws, clears, deletes, returns record/null; teardownAll returns count: :44-53, :72-77.
- `authenticated()` filters `e2e.state==='authenticated'`: :70.
- Test covers all listed cases: `remoteClientSessions.test.cjs:13-101`; passes.

## mc-agent-per-client-e2e — VERIFIED
- `_clients = createClientSessions()` held; no `_e2e/_e2ePeerPubKey/_e2eDeviceId` identifiers remain (grep of webRemote.cjs: none).
- `getOrCreate(clientKeyOf(envelope), {clientId: envelope.fromClientId ?? null})` after ping/pong/auth/error handling, before hello/box/cmd, passed to dispatch+respond: `webRemote.cjs:867`.
- hello mutates only `client`; `failClient` touches one record: :215-220, hello block :868-945. Test "isolates re-hello" passes.
- e2e:box decrypts with `client.e2e.sessionKey`, dropped+logged when absent; plaintext-after-E2E check per client: :948-985.
- `respond` encrypts with client key; `toConn` only when key≠legacy: :1057-1064.
- MUTATE/SAS_GATED_READS gate uses `client.e2e.state`: dispatchEnvelope.
- `getE2eState(clientKey='legacy')`, `setE2eAuthenticated(key, clientKey)` retained: :1465-1473. Existing pinning/pty/unit specs pass.
- New test file exists with two-client cmd reply/toConn/re-hello test (`web-remote-multi-client.test.cjs:119`).

## mc-agent-per-client-streams — VERIFIED
- `_remotePtyStreams`, `stopRemotePtyStream`, `stopAllRemotePtyStreams`: no matches in file. `cmd:pty:spawn` registers in `client.ptyStreams`, pushes via `pushEventTo(client,…)` gated on client auth + remoteEnabled: :1100-1128.
- subscribe/unsubscribe use `client.subscriptions`; state/summary go through `subscribersOf(tabId)` (authenticated+subscribed): :514-517, :635, :782-792; watcher pruned only when no subscriber: `pruneSessionWatchers` :519-523. session:list per-client diff-guard `lastSessionListJson`: :745-748.
- `event:client:disconnected` handled before dispatch, calls `teardownClient(key)`, audits `client:disconnected` with reason, broadcasts status: :853-865.
- ws close, revokeDevice, revokeAllDevices, handleTokenRevoked, disable (via `disconnect()`→`resetE2e()`→teardownAll), disable-control all tear down all clients: :447, :1279, :1304, :475, :1395.
- auditLog line format `<ts>  type  deviceId=  client=  msgId=  result=`; all call sites pass client: :147-152.
- Tests (a)-(d) present: `web-remote-multi-client.test.cjs:288,302,318,330`; pass. `streamCount` sums across clients: :1476.

## mc-agent-per-client-sas-pins — VERIFIED
- `verifiedPeerPubKeys` list, max 20 newest kept, hello auto-auths on list or legacy single key; confirm-sas only appends: :246-259, :1354.
- `webRemoteConfirmSas` schema (`clientKey` string max 64, optional, strict): `ipcSchemas.cjs`; confirm-sas with key or single pending, `ambiguous_pending_sas` when >1: :1327-1342.
- `computeStatus` keeps old fields + `clients:[{key,clientId,state,pendingSas}]`, no key material: :268-290; preload `confirmSas(clientKey?)` and `api.d.ts` updated.
- `SettingsRemote.tsx` renders one SAS row per pending client, label clientId else 'Phone' (label shown when >1; single pending looks as before), confirms with own key.
- Multi-pin test `web-remote-multi-client.test.cjs:173`; pinning spec, unit specs, typecheck, lint pass.

## Combined-diff review
- Module-wide E2E / PTY state: none left. Remaining module state is `_ws`, `_sessionWatchers` (shared watcher, subscriber-pruned), timers — intended.
- Push reach: every unsolicited push goes through `pushEventTo(client…)`; recipients are the owner or authenticated subscribers; all non-legacy sends carry `toConn`.
- Key material: log lines carry only error messages/state/counts; status `clients` has key (relay conn id), clientId, state, SAS code only (SAS is already in status today). No sessionKey/pubKey in logs or status.
- Legacy: absent fromConn → 'legacy' client, no `toConn`, `confirm-sas` falls back to legacy; behaviour preserved. `event:client:disconnected` without fromConn is a no-op.
- `/code-review` and `/security-review` not run as separate skills; self-review done.

## Findings
### Critical
- none
### Important
- none
### Minor
- `webRemote.cjs:867` — `getOrCreate` runs for any `fromConn` before authentication; a hostile/buggy relay can mint unbounded client records (keys capped at 64 chars, count not capped) until ws close. Consider a registry size cap.
- `webRemote.cjs:1135-1150` — `cmd:pty:write/resize/kill` are not scoped to the client that owns the tab's stream (any authenticated client can drive any tabId). Pre-existing host-wide model; the kill path correctly clears every client's stream. Worth a decision if clients should be isolated beyond streams.
- `cmd:pty:kill` leaves an unused `void reqClient` (`webRemote.cjs:1144`) — cosmetic.
- `<path>` stray 0-byte file at repo root is the known sqlite MCP placeholder, not part of this plan.
