---
title: Register a project's cwd as a write-allowed root when it's first known, not only on PTY spawn
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: epic-scheduler-integration-audit-follow-ups-sour-bf812a26
---

# Goal

`src/main/config.cjs`'s `validateWrite` (~line 99-174) only permits writes into a project's
`session-manager-operations/{scheduler,prompt-sessions,feedback,project-brief}/` subtrees — and
therefore PRD authoring, prompt-session event writes, feedback filing, and project-brief
persistence — for cwds present in the module-level `allowedRoots` Set. That Set only gains a
project's cwd via `addAllowedRoot()`, and a full grep of every call site
(`src/main/pty.cjs:98`, `src/main/lib/rcaFeedbackHook.cjs:372`, plus the definition in
`config.cjs` itself) shows `addAllowedRoot` is **only ever called from `pty.spawn()`** — i.e.
only when a literal interactive Terminal PTY is spawned for that cwd. There is no boot-time or
tab/Epic-open-time registration anywhere else.

Reproduced directly (no app restart needed, plain `node -e` against a fresh `config.cjs`
`require`, simulating the state before any PTY has spawned for a project this session):

```
$ node -e "
const config = require('./src/main/config.cjs');
const real = config.validatePath('/home/bilko/Projects/session-manager/session-manager-operations/scheduler/epics/some-epic/prds/862-x.md');
config.validateWrite(real);
"
Uncaught Error: Write outside allowed write boundaries: /home/bilko/Projects/session-manager/session-manager-operations/scheduler/epics/some-epic/prds/862-x.md
```

Practical effect: any Epic driven purely through its Chat view (headless `claude -p --resume`
via chatRunner — CLAUDE.md's domain model explicitly allows this; no Terminal PTY is required)
fails EVERY write into its own project's operations root — PRD authoring
(`chat:create-prd` → `prdCreate.createPrd` → `remote.writePrd` → `config.writeTextAtomic` →
`validateWrite`), prompt-session event appends, feedback filing, project-brief saves — with the
exact "Write outside allowed write boundaries" error, purely because no Terminal tab for that
project happened to spawn a PTY yet in the current app process's lifetime. `validatePath` (the
read boundary, home-dir-wide) passes fine first, which is why the failure surfaces as a
confusing boundary rejection deep in `writeTextAtomic` rather than an early, clear "project not
yet registered" error.

Immediate user-facing workaround (documented here for support purposes, not a fix): opening a
Terminal tab for the affected project once calls `pty.spawn()` → `addAllowedRoot()`, after which
all Epic/Chat-only writes for that cwd succeed for the rest of the app session.

# Acceptance criteria

- [ ] A project's cwd is added to `allowedRoots` (via `addAllowedRoot`, reusing the existing
      `checkInsideHome`-then-`addAllowedRoot(r.realPath)` pattern from `pty.cjs:94-98`, not a
      new/duplicate boundary check) at the point the app first learns of that project — at
      minimum, everywhere a cwd reaches `ensureEpic`/`writePrd`/`prdCreate.createPrd` without a
      PTY having been spawned first (the `chat:create-prd` IPC handler and the
      `/admin/scheduler/create-prd` route are the two known entry points; find any others via
      the `writeTextAtomic`/`validateWrite` call graph)
- [ ] `pty.spawn()`'s existing `addAllowedRoot` call is left in place (still correct, just no
      longer the *only* registration path)
- [ ] A unit test covers: `chat:create-prd` (or the underlying `prdCreate.createPrd`) succeeds
      for a cwd that has never had a PTY spawned in the test process, reproducing this PRD's
      repro case as a regression test
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] `timeout 600 npm run test:unit` passes.

# Implementation notes

Read `src/main/config.cjs:60-174` (`allowedRoots`, `addAllowedRoot`, `validatePath`,
`validateWrite`) and `src/main/pty.cjs:90-98` (`checkInsideHome` + `addAllowedRoot` pattern —
reuse this exact home-boundary check, don't invent a second one). Trace every caller that reaches
`config.writeTextAtomic`/`validateWrite` for a `session-manager-operations/...` path without
going through `pty.spawn` first: `src/main/index.cjs:790` (`chat:create-prd` handler) and
`src/main/lib/prdCreate.cjs`'s `createPrd`/`registerAdminRoute` (used by the
`scheduler_create_prd` MCP tool via the admin HTTP route) are the two paths known to hit this;
also check `ensureEpic`'s callers more broadly (`src/main/scheduler.cjs`'s feedback-sweep path)
in case a project cwd reaches there before any tab/PTY exists for it.

`prdCreate.createPrd` already calls `config.validatePath(cwd)` up front (see its comment
"cwd is untrusted... Route it through config.cjs's validatePath") — that's the natural,
already-present chokepoint to also call `addAllowedRoot` from, since it already has the
validated/realpath'd cwd in hand and every affected entry point (`chat:create-prd` IPC handler,
the admin HTTP route) funnels through it.

# Out of scope

- Do not weaken `validateWrite`'s allowlist itself (e.g. don't fold the write-prefix checks into
  `validatePath`'s broader home-dir check) — the tighter write boundary is intentional; only fix
  *when* a legitimate project root gets registered into it.
- Do not touch `pty.cjs`'s existing PTY-spawn registration.

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
