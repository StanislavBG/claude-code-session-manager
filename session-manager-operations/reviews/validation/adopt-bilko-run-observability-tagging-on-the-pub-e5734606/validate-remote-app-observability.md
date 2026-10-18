# Validation: remote-app observability tagging

Base: 283b6a06 (HEAD c20166f6). Commits: 758b9974, 2dd5f814, 1e7a1a7f, 9dba3d4c, 68f4f72a, c20166f6. PRD files found in `prds-archived/`.
Environment note: `web/remote-app/node_modules` was absent in the job worktree; ran `npm ci` there (gitignored) before the gates.
Full suite `npm --prefix web/remote-app test`: 24 files / 126 tests pass. Typecheck exit 0. `run build` exit 0.

## remote-app-telemetry-module — VERIFIED
- Exports APP/track/trackFlow/trackScreen: telemetry.ts:6,38,42,47.
- Beacon Blob JSON `{batch:[{app,name,ts,props}]}`, path default, fetch fallback w/ keepalive + swallowed rejection: telemetry.ts:11-33.
- PII_RE redaction + outer try/catch: telemetry.ts:9,13-15,34.
- FLOW_RE validation, `${flow}.${step}`, `screen_view`: telemetry.ts:42-50.
- Spec telemetry.spec.ts: 8 tests pass. No package.json change; no src/main change (`git diff --stat -- src/main package.json web/remote-app/package.json` empty).
- Gate: telemetry.spec.ts + typecheck green.

## remote-app-screen-views — VERIFIED
- Cockpit.tsx:41-42 effect keyed on screenName (projects/sessions/session/awaiting-desktop), dedup by dep.
- App.tsx:190 connect, :192 sas-confirm; :218-220 `data-track="sas-dismiss"`; :160 `trackFlow('pair','success')` inside offReady.
- Gate (screens, drilldown-routing, remote-ready, await-desktop-confirm, auth-gate + typecheck): 26 tests pass.

## remote-app-track-connect-projects — VERIFIED
- ConnectScreen: connect-pair-another/generate-code/forget-offline/forget-device/refresh present; generate() flow at :48-50 (reason constant, no code/err in props).
- DesktopClientsPanel: desktop-client-mint/revoke. ProjectsScreen: projects-retry, projects-open + data-track-redact.
- Gate: 22 tests pass + typecheck.

## remote-app-track-sessions — VERIFIED
- SessionsScreen: back/new/retry/open-main(+redact)/open-epic(+redact). NewSessionSheet: close/macro(+redact)/dictate/start; mount effect :48-51; submit/success/fail(desktop-error|send-error) props `{tag}` only (:110-129). SessionScreen: session-back, session-prds-toggle.
- Gate: 23 tests pass + typecheck.

## remote-app-track-mic-chat — VERIFIED
- MicPane: mic-chip(+redact), mic-send, mic-start, mic-sheet-close/cancel/send; sheet effect :55; source derivation :85, flow :86-93 (no message text). SummaryPane summary-toggle.
- Gate: 12 tests pass + typecheck.

## remote-app-data-track-unique-test — VERIFIED
- data-track-unique.spec.ts exists, passes (in full suite); asserts format, cross-file uniqueness, button count == literal count.
- Full-suite gate + typecheck green.

## Plan-wide — VERIFIED
- All 17 call sites enumerated via grep: props are only `{tag}` (closed taxonomy), `{source}`, `{reason: const}`; no title/prompt/cwd/deviceId/code/SAS/error message. Screen names are constants.
- Build succeeds. Nothing under src/main changed.

## Findings
### Critical
- none
### Important
- none
### Minor
- MicPane.tsx (~sheet backdrop): the backdrop `<div aria-hidden>` became a `<button tabIndex=-1 aria-label="Close voice sheet">` to satisfy the button-tagging guard. Behavior-preserving for taps, but alters the DOM/a11y semantics beyond the PRD's "add attribute"; a reviewer may prefer a non-button tagged element.
- The data-track-unique guard counts `<button` per file only; non-button clickables (e.g. `<a>`, role=button divs) are not covered.
- A stray 0-byte `<path>` file is untracked in the worktree (known sqlite-MCP placeholder, unrelated).
