# Validation: phone drill-down plan (2838, 2839, 2840)

Base: f91bb34a. Commits: ead8c2e9 (2838), be6410f0 (2839), 1851eed8 (2840).
Environment note: the job worktree had no `web/remote-app/node_modules`, so every gate failed on the missing `@testing-library/jest-dom`. I symlinked the main checkout's gitignored `node_modules` into the worktree and re-ran. Nothing tracked changed.

## remote-app-phone-view-mode — VERIFIED
- `src/viewMode.ts:11-45`: exports ViewMode, VIEW_MODE_KEY='sm-remote-view-mode', PHONE_QUERY (exact string), defaultViewMode (full when matchMedia is missing, or on throw), loadViewMode (invalid or storage error falls back to default), saveViewMode (swallows errors).
- `Cockpit.tsx:45` `useState<ViewMode>(loadViewMode)`, read once at mount. There is no resize listener.
- `Cockpit.tsx:130` the only change to the branch is the added `viewMode === 'full' &&`. The `<RemoteRenderer key=… socket deviceId fallback={body} />` line and the `: body` arm are unchanged in the diff. The fallback, OutdatedBanner and watchdog live in RemoteRenderer, untouched. In phone mode RemoteRenderer is never mounted.
- `Cockpit.tsx:108-115` the toggle has data-testid=view-mode-toggle, data-track=cockpit-view-mode, class min-h-touch, and the label 'Full UI' in phone mode and 'Phone view' in full mode. It calls saveViewMode, then setViewMode.
- `cockpit-view-mode.spec.tsx` has 14 tests, all passing.
- `web/remote-app/CLAUDE.md` gained one line (+1 in the diff).
- Gate: 11 files, 69 tests, all passed.

## remote-app-typecheck-green — VERIFIED (scope deviation, Minor)
- Gate `npm --prefix web/remote-app run typecheck`: exit 0.
- `real-chain.browser.spec.ts`: only the `type RawData` import and the annotations `(sock: WsSocket)` and `(data: RawData)`. These are type-only.
- `remote-renderer-entry.tsx`: removed `declare global { Window.__socket }` and cast `window` locally. The runtime expression is the same value.
- Deviation: the PRD said only those two files change, but `src/__tests__/ws-package.d.ts` (+29 lines) was also added. It is a type-only ambient declaration for `ws`, since @types/ws is not installed. It is test-only, with no runtime, package.json or lockfile change. I judge it justified, but it is outside the stated Files.

## remote-app-phone-drilldown-chain-spec — VERIFIED
- Gate: the spec passed (1 test, about 2 s) and typecheck exited 0.
- Screenshots (/tmp/sm-phone-chain-shots-7gZ9bI/), which I opened:
  - 1-projects.png: the phone-proj row ("1 active · 1 proposed") fits the width. The header shows the Full UI toggle, the device switcher and "live". No overflow.
  - 2-sessions.png: Main, the Active epic and the Proposed epic all fit. No overflow.
  - 3-session-after-send.png: the user bubble, the assistant reply ("Yes: the projects, the sessions and this reply all came over the relay."), the pending bubble "Ship it from the phone" with the "Sent" label, and the composer are all visible. The suggestion chips scroll inside their own strip, so the document does not overflow.
- `phone-drilldown-chain.browser.spec.ts:271` uses viewport 390x844, isMobile and hasTouch. `:338-339` asserts document scrollWidth <= 390 on each screen.
- `:396` asserts `audit not.toMatch(/asset:(manifest|get)/)`. This is a real check on the real audit log. `:392-394` requires result=ok lines for the four cmd types. `:399-400` asserts no renderer iframe and `__rendererSeen` false.
- `:385-390` asserts enqueueExternalPrompt was called once with the Epic id, the prompt and sessionId/cwd.

## Combined diff review (self-review; no tooling beyond manual reading)
No secrets, no path traversal, and the tests use a temp HOME and os.tmpdir(). No duplicated helper found.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `ws-package.d.ts` is outside the 2839 Files list (see above).
  - Phone header titles truncate heavily ("Sessio…", "phone…") because the toggle takes space (`Cockpit.tsx:108`). This is cosmetic.
  - `real-chain.browser.spec.ts` and the other full-mode browser specs were not re-run, because they need a dist-web build and are outside these gates.
