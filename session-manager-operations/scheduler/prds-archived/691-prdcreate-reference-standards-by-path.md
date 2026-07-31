---
title: Make prdCreate.cjs's buildPrdBody reference standards.md by path, matching the /develop skill
cwd: ~/Projects/session-manager
estimateMinutes: 15
---

# Goal

The `/develop` skill (`plugins/session-manager-dev/skills/develop/SKILL.md`) was just changed so
that every PRD it authors points the headless executor at `standards.md`'s absolute path with an
instruction to `Read` it before starting, instead of embedding the file's full contents verbatim.
This removes a staleness failure mode (a long authoring session shipping a stale in-context copy
if `standards.md` changed mid-session — the exact cause of a prior incident on PRDs 467/468) and
shrinks every PRD file since the ~130-line standards block is no longer duplicated into it.

`src/main/lib/prdCreate.cjs`'s `buildPrdBody` — the second, programmatic PRD-creation path (used
by the `create-prd` admin route and exposed as the `scheduler_create_prd` MCP tool) — still does
the old thing: `readStandards()` reads the file fresh and `buildPrdBody` embeds
`standardsText.trimEnd()` verbatim at line 65. Left as-is, the two PRD-creation paths in this
codebase would now produce differently-shaped PRDs for the same underlying concept, which is
exactly the "N implementations, one concept" drift this project's own standards warn against —
notably, this file's own header comment already claims "same one-concept-one-implementation
reasoning that keeps the `/develop` skill re-reading it fresh per PRD," so bringing it in line is
completing that stated intent, not introducing a new one.

# Acceptance criteria

- [ ] `src/main/lib/prdCreate.cjs`'s `buildPrdBody(input, standardsText)` (currently accepting the
  full standards text and embedding it at line 65 via `standardsText.trimEnd()`) is changed to
  build the same one-line pointer block the `/develop` SKILL.md now documents:
  ```
  ## Engineering standards

  Before writing any code, read `<STANDARDS_PATH>` — it has the Performance, Debugging,
  API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
  mandatory, especially Execution discipline (bounded commands, verify before done, the
  finish-protocol sentinel).
  ```
  using the already-exported `STANDARDS_PATH` constant (`prdCreate.cjs:25-28`) in place of the
  embedded text. Decide during implementation whether `buildPrdBody` still needs a
  `standardsText`/second parameter at all (it likely doesn't, once nothing is embedded) — if not,
  drop the parameter and update its one call site in `registerAdminRoute` (`prdCreate.cjs:143`)
  to stop calling `readStandards()` beforehand (removing the now-unnecessary try/catch at lines
  135-141, since there is nothing left to fail by reading the file at request time — the pointer
  is just the constant path).
- [ ] Keep `readStandards()` exported from the module (`module.exports` at line 154-161) even if
  `buildPrdBody` no longer calls it internally — grep the renderer/web-remote surfaces for any
  other consumer of `prdCreate.readStandards` or an equivalent "preview the standards text"
  feature before removing it; if none exists, it's still fine to leave the small pure function
  exported and unused-internally rather than deleting a working, documented utility outside this
  PRD's actual scope.
- [ ] Update the module's header comment (lines 1-14) to describe the new behavior — replace
  "Standards are read fresh from disk on every call... so a live edit to standards.md is picked
  up by the next create-prd call without an app restart" with the more accurate framing: neither
  path embeds the text at all now, so there's nothing to go stale — both `/develop` and this
  admin route just point the executor at the same absolute path.
- [ ] Update/extend whatever existing unit tests cover `buildPrdBody` (search
  `find src/main -iname '*prdcreate*spec*' -o -iname '*prdcreate*test*'` — PRD 689 moved/added
  tests here recently, reuse and adjust rather than duplicate) to assert the produced body's
  `## Engineering standards` section contains the `STANDARDS_PATH` value and the "Read ... before
  writing any code" instruction, not the embedded standards text.
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 120 npx vitest run <files you touched>` passes.

# Implementation notes

- Read `src/main/lib/prdCreate.cjs` in full first (it's short, 162 lines) — this is a small,
  mechanical change to one function's output shape plus removing now-dead error handling around
  it, not a rewrite of the route's orchestration logic (auth, cwd validation, NN allocation,
  collision check all stay exactly as they are).
- Match the exact wording of the pointer block already added to
  `plugins/session-manager-dev/skills/develop/SKILL.md`'s Phase 1 step 4 — read that file's
  current "## Engineering standards" template block and reuse it verbatim (via `STANDARDS_PATH`
  interpolated in) so a PRD created through either path reads identically.

# Out of scope

- Do not change NN allocation, cwd validation, or the collision-check logic in
  `registerAdminRoute` — only the standards-embedding behavior changes.
- Do not change `/develop`'s SKILL.md further — it already has the pointer-block change this PRD
  is bringing `prdCreate.cjs` in line with.
- Do not touch `localAdminHttp.cjs` or `scheduler.cjs`'s route registration.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
