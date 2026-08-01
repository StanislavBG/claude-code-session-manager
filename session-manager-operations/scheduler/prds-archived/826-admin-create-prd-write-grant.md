---
title: Fix — admin create-prd cannot write into per-project scheduler epics dirs
cwd: ~/Projects/session-manager
estimateMinutes: 12
sourcePromptId: admin-create-prd-api-cannot-write-into-per-proje-15268047
---

# Goal

The admin API / MCP `scheduler_create_prd` path is broken for the per-project Epic PRD dirs
introduced by the TAB→EPIC→PRD migration (commit 6586edb): `remote.writePrd`
(`src/main/scheduler.cjs`, ~line 4079) writes via `config.writeTextAtomic`, whose
`validateWrite` (`src/main/config.cjs:98-158`) allowlists project-root writes only under
`.claude/`, `tests/fixtures/browser-capture/`, `tests/e2e/`, and
`session-manager-operations/{browser,feedback,prompt-sessions}/` — NOT
`session-manager-operations/scheduler/`. Live repro 2026-07-31: POST /admin/scheduler/create-prd
returned `Write outside allowed write boundaries: …/session-manager-operations/scheduler/epics/<epic>/prds/825-….md`
and left an empty minted Epic dir behind. Additionally, an unexpanded `~/...` cwd reaches
`safeSlugPathIn` and fails as bare `invalid slug` (confusing error).

# Acceptance criteria

- [ ] `validateWrite` in `src/main/config.cjs` gains a narrowly-scoped grant for
  `session-manager-operations/scheduler/` under registered project roots (mirroring the
  existing prompt-sessions grant comment style — cite this PRD).
- [ ] `createPrd` in `src/main/lib/prdCreate.cjs` normalizes `input.cwd` through the same
  `expandHome` it already uses for validation (~line 112) BEFORE passing it to
  `allocateParallelGroup`/`readPrd`/`writePrd`, so a `~/Projects/...` cwd creates correctly
  instead of failing with `invalid slug`.
- [ ] On any create failure after `ensureEpic` minted a brand-new empty Epic dir, the empty
  `<epic>/prds` + `<epic>` dirs are cleaned up (best-effort; only when `created === true`
  and the dir is empty).
- [ ] Unit tests: extend `src/main/__tests__/prdCreate.test.cjs` (and/or config tests) —
  a create targeting `<projectRoot>/session-manager-operations/scheduler/epics/<id>/prds/`
  passes validateWrite; a `~`-prefixed cwd round-trips; `timeout 300 npx vitest run
  src/main/__tests__/prdCreate.test.cjs` (or the repo's matching runner for main-process
  tests — check how existing `*.test.cjs` under src/main are run, e.g. via vitest config)
  passes.
- [ ] `timeout 300 npm run typecheck` passes.

# Implementation notes

Read `src/main/config.cjs` validateWrite (the ordered grant list, lines ~98-158),
`src/main/lib/prdCreate.cjs` (createPrd at 104, `expandHome` import), and
`src/main/scheduler.cjs` remote.writePrd (~4026-4090, incl. the ensureEpic fallback).
Keep the grant narrow — `session-manager-operations/scheduler/` only, not the whole
operations dir: this API's product runs later with `--dangerously-skip-permissions`, the
boundary is a real security control (see the comment block at prdCreate.cjs:105-110).

# Out of scope

- Widening any other write grants.
- Changing the admin HTTP surface, MCP wrapper, or NN allocation.

## Engineering standards

Before writing any code, read
`/home/bilko/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md`
— it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply
to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands,
verify before done, the finish-protocol sentinel).
