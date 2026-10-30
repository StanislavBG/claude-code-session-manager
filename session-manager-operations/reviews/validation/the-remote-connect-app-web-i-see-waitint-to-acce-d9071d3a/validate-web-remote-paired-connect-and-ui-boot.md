# Validation: web remote paired connect + UI boot

Base `a3f3d6810fbd` → HEAD. Commits: 7fa57eb3 (2368), 2de18d11 (2369), 5c1379d5 (2370), fa4c42df (2371), 335e469b (2372). PRD files found in `prds-archived/` (2368–2372).
Gates re-run: `npm --prefix web/remote-app ci && typecheck && test` → 28 files / 182 tests green, typecheck 0; `npm run lint:docs` 0; desktop vitest (4 web-remote files, SM_* unset) → 11 passed. `/code-review` and `/security-review` not run; self-reviewed (no secrets, no path traversal; bootstrap is a fixed string, scripts reach the frame only after sha256 verification, `postMessage` targetOrigin `'*'` is required for an opaque-origin frame and the frame checks `e.source === parent`).

**Gate blind spot:** `web/remote-app/vite.config.ts:18` includes only `src/**/*.spec.{ts,tsx}`. `remoteRenderer.test.tsx` and `remote-renderer-boot.browser.test.ts` are `.test.*`, so the gate (and `npm test`) never runs them. I ran them with a temporary config including `*.test.*` (removed afterwards).

## remote-app-hold-early-e2e-boxes-until-handshake — VERIFIED
- Per-socket promise chain with warn on error: `ws.ts` `this.inbound = this.inbound.then(()=>dispatchAsync).catch(warn)` (diff @ connect()).
- Held list, cap 16 (`HELD_BOX_CAP`), no-session box still dropped, drain in order after emitting `e2e:ready`, bad box dropped with warn: `ws.ts` e2e:box / e2e:ready branches.
- `sas:pending` only if no drained `event:remote:ready` (`if (sawRemoteReady) return;`).
- CLAUDE.md line added (diff). Spec cases a/b/c pass (verbose run). Existing rehandshake/remote-ready/await-desktop-confirm/remoteRenderer specs pass in the gate.

## remote-app-e2e-held-box-hardening — VERIFIED
- deviceId stamping `inner.deviceId ?? deviceId` on live and drain paths (`ws.ts`).
- `resetE2E` clears `held` for one/all sessions; `initiateE2E` reuses same-key keyless session, replaces on different key.
- Tests (d)(e)(f) pass; multi-device / rehandshake / remote-ready pass in gate.

## remote-app-pair-success-only-after-sas — VERIFIED
- `App.tsx` reads state before `markRemoteReady`, `trackFlow('pair', sasFlow ? 'success' : 'resumed')`; rest of handler unchanged.
- `telemetry-screens.spec.tsx`: existing success test and new "pair resumed" test pass.

## desktop-pinned-hello-frame-order-contract-test — VERIFIED
- `web-remote-pinned-ready-order.test.cjs` + 3 existing web-remote tests: 4 files / 11 tests pass. Comment-only change in `webRemote.cjs` (diff shows only `//` lines above `finalizeE2eAuthenticated`).
- Cross-PRD: desktop test asserts frame[0] `e2e:box`, frame[1] `e2e:ready`; `ws.ts` holds the early box and drains it before deciding on `sas:pending`; spec (a) serves exactly that order. Consistent.

## remote-renderer-boot-script-inside-sandbox — REFUTED (test landing defect; product behavior verified)
- `IFRAME_SANDBOX` unchanged (`RemoteRenderer.tsx:11`, no allow-same-origin); no `createObjectURL`/`revokeObjectURL` left (grep clean); `buildSrcDoc(html, css)` strips `<script src>` and inserts exported `BOOTSTRAP`; loader keeps verified scripts in `scriptsRef`; `sm-boot-ready` handled before `bridge.handle`.
- Real-Chromium `remote-renderer-boot.browser.test.ts`: both cases pass when run (probe delivered; pre-fix blob pattern never delivers). First line `// @vitest-environment node`, `chromium.launch()` not skipped.
- **FAIL:** AC 4 requires `remoteRenderer.test.tsx` updated in lockstep so the component test passes. When run, "posts sm-boot with verified code after sm-boot-ready, without bridging it" fails deterministically (2/2 isolated runs; `post` spy never called with sm-boot); in the full run "maps subscribe to ipc:subscribe…" also failed once. A probe test that waits for the frame to settle shows the component does post the correct `sm-boot` payload, so the defect is test timing, not product code. Because of the include pattern these tests are never run by the gate, so the red went unnoticed.

## Findings
**Important**
1. `web/remote-app/src/__tests__/remoteRenderer.test.tsx:62-66` — sm-boot test red when executed (listener/effect race after `mounted()` returns); likely second red at "maps subscribe…" (flaky, 1 of 3 runs).
2. `web/remote-app/vite.config.ts:18` — include `*.spec.*` excludes `remoteRenderer.test.tsx` and `remote-renderer-boot.browser.test.ts`; the PRD's gate cannot exercise the real-Chromium test. Rename to `.spec` (or widen include) so the gate covers them.

**Minor**
3. `ws.ts` — `initiateE2E` still sends duplicate hello (explicitly out of scope).
4. Base remoteRenderer.test.tsx also had a red case outside the gate (pre-existing: same blind spot).
