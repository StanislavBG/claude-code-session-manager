# Claude Code Session Manager

Electron desktop app — local cockpit for Claude Code CLI. Terminal + 25+ config/observability/scheduling
tabs. Per-project state lives under `<cwd>/session-manager-operations/`.

**This file holds the laws. The rationale behind each lives in a linked reference doc — follow the link
before changing anything in that area.** Reference docs, all under `session-manager-operations/architecture/`:

> **SIZE BUDGET — 12,000 chars**, checked with `wc -c CLAUDE.md` before every commit. This file is
> read on every turn of every session. A new law is ONE line here; its rationale goes in the linked
> doc. Over budget means **split, don't append**. Correcting a wrong line does not license a longer
> one — rewrite at the same length, move the "why" to the doc. (The file hit 65,768 chars by
> 2026-08-24: 57 feature commits appended, 0 of 359 PRDs ever pruned, and 7 of 8 `docs(claude-md)`
> "cleanup" commits *grew* it. This paragraph is the only reaper.)

| Doc | Covers |
| --- | --- |
| [`domain-model.md`](session-manager-operations/architecture/domain-model.md) | TAB / EPIC / PRD, Agent+Tag, AIM prompt, worktree isolation, single-writer law |
| [`code-map.md`](session-manager-operations/architecture/code-map.md) | Load-bearing main + renderer files, renderer data flow |
| [`conventions.md`](session-manager-operations/architecture/conventions.md) | Conventions + the full **Avoid** list (every entry is a real incident) |
| [`bilko-run-marketing.md`](session-manager-operations/architecture/bilko-run-marketing.md) | Product page, Stripe checkout, npm listing (sibling repo `~/Projects/Bilko/`) |
| [`build-target.md`](session-manager-operations/architecture/build-target.md) | Build/publish target resolution |
| [`ops-maintenance-protocol.md`](session-manager-operations/architecture/ops-maintenance-protocol.md) | Ops-folder drift sweeps |

## Stack

Electron 33 (CommonJS main + preload) · React 18 + Vite · Tailwind · zustand · xterm + node-pty · Whisper
(ricky0123/vad-web + onnxruntime-web) for voice.

## Commands

- `npm run dev` — Vite + Electron with HMR. `SM_DEV=1` set automatically.
- `npm run build` — production renderer build into `dist/`.
- `npm run typecheck` — `tsc --noEmit`. Must pass before commits.
- `npm run test:unit` — `vitest run`. Single file: `timeout 120 npx vitest run <path>`. NOT `node --test` —
  it can't resolve the TypeScript renderer imports.
- `npm run test:e2e` — Playwright Electron under `xvfb-run` (Linux).
- `npm run lint` — `lint:selectors` + `lint:hooks`. Both guard blank-screen crashes; run alongside typecheck.
- `npm run health` — `src/main/health.cjs`. Exit 0 = GREEN. Entry for `/local-project-health`.
- `npm publish` — runs `vite build` via `prepublishOnly`. Tag `latest`.

## Domain model — the laws

Full detail + rationale: [`domain-model.md`](session-manager-operations/architecture/domain-model.md).
Any new feature touching sessions, navigation, or per-project state must map onto the TAB → operations-root
→ EPIC → session hierarchy rather than inventing a parallel scoping scheme.

- **TAB = cwd = Main Project.** One TAB per project; extra sessions within a project are Epics, not tabs.
- **EPIC = one unit of work** (`PromptSession`). "Sessions" is the user-facing name; `Epic`/`PromptSession`/
  `epicId`/`epic-*` testids/on-disk paths stay the code name — don't "finish" the rename into identifiers.
- **EPIC : claude-session = 1:1.** Chat and Terminal are two VIEWS over one session — switching hands off the
  session, never mints a new sessionId. Active Epics run in their own `git worktree` (branch `sm-epic/<id>`).
- **Epic creation is two independent selections:** `agentType` (Actor — who) + `tag` (Mission — what). Both
  libraries are full CRUD editors, not read-only. `tag`'s 5-tag taxonomy is a closed union.
- **The opening prompt is AIM — Actor, Input, Mission, in that order**, composed only by
  `lib/epicIntake.ts`'s `composeEpicIntake`. It is framing, never a second source of truth for what the CLI loads.
- **An Epic's title + objective are fixed for the life of its session.** Iterate in follow-up messages; start a
  new Epic rather than repurposing one. (Queue-row rename is a cosmetic carve-out only.)
- **Lifecycle is the single `status` field** — exactly `proposed` / `active` / `completed`, specified in
  [`prompt-sessions/README.md`](session-manager-operations/prompt-sessions/README.md#lifecycle). No `draft`
  state. **Every Epic is born `proposed`**; nothing is created directly as `active`. Don't restate the
  lifecycle elsewhere — link there.
- **SINGLE-CREATOR LAW: an Epic is created in exactly one place — a human pressing New Epic.** Enforced
  fail-closed in `src/main/lib/epicMint.cjs`; `MINT_AUTHORITIES` has exactly two entries (the New Epic IPC
  handler, and `crossProjectFeedback.cjs`). A third entry is a domain-model change, not a convenience. There
  is **no agent-facing proposal channel** — an agent sure that work is needed runs `/develop` inside the Epic
  it is already in. PRDs join an existing Epic; they never conjure one.
- **Cross-project feedback lands as a `proposed` Epic in the RECEIVING project** (`crossProjectFeedback.cjs`,
  `feedback_open_session` MCP tool, `session-manager-dev:send-feedback` skill). `toCwd === fromCwd` is
  rejected — that's `/develop`.
- **An ACTION is an Agent persona given a project scope**, not a fourth concept — `projects:`/`action:`/
  `actionLabel:` frontmatter renders a button in that project's Sessions toolbar. Pressing it is the same act
  as pressing New Session, through the same mint authority.
- **Settings (System/Project/Local) is substrate, not per-Epic curation.** If a behavior should differ per
  Epic, it is a Tag, an Agent persona, or a future PRD — never a plain Settings edit. `model` is the one
  field carved out per-Epic (persona frontmatter wins over the Settings default).
- **SINGLE-WRITER LAW over the operations root** (`src/main/lib/opsOwnership.cjs`). Every
  `session-manager-operations/<namespace>/` has exactly ONE owning writer; everyone else reads. Fail-closed —
  an undeclared writer throws. Adding a namespace or writer is a deliberate edit to that file. Build ops
  paths only via its `opsPath()`. Read its `README.md` first.
  - **Owned** (in `OWNERS`, app-owned runtime state): `prompt-sessions` → epics · `scheduler` → scheduler ·
    `project-brief` → project-home · `logs` → logs · `bilko-host` → bilko-host · `project-pages` →
    project-home (app's admin render route only; a Builder Epic's own Write-tool authoring stays ungoverned —
    see `project-pages/README.md`).
  - **Deliberately NOT owned** (skill-authored docs/artifacts, no concurrent-write hazard — this is the
    correct split, not a gap): `architecture`, `design-mocks`, `HUMAN_LEARN`, `manual`, `reviews`.
    `feedback` **retired** (2026-08-02). `browser` is a leftover artifact folder, safe to delete on sight.
  - **Any new top-level folder under `session-manager-operations/` must land in this enumeration or in
    `OWNERS` in the same PR that creates it** — `scripts/ops-sweep.cjs` greps this list and reports an
    unlisted namespace as `UNDOCUMENTED`. Don't add a speculative `general` namespace.
- **Open-core: the APP is free and stays free.** Field Manual is the only paid artifact. Never add a license
  check, entitlement gate, trial limit, nag, or "pro" tier, and never move an app feature behind a purchase.
- **The bilko.run relay stays live** — desktop half of web remote removed 2026-08-06 (restore `b014cc2`). Do
  NOT delete/decommission the relay, its routes, or the product-page copy in `~/Projects/Bilko/`.

## Scheduler

Runs PRDs from `<cwd>/session-manager-operations/scheduler/epics/<epic-id>/prds/` as `claude -p` jobs. Detail:
[`code-map.md`](session-manager-operations/architecture/code-map.md),
[`scheduler/README.md`](session-manager-operations/scheduler/README.md).

- **PRD authoring is API-only** — the `scheduler_create_prd` MCP tool is the sole sanctioned way to write a
  PRD file. Hand-writing one is a degraded last resort (app not running) and must be reported visibly.
- Flat `scheduler/prds/` is **RETIRED** — auto-consolidated into `prds-archived/` on every `reconcile()` pass.
- Before writing a PRD, read
  [`PRD_AUTHORING.md`](file:///home/bilko/.claude/session-manager/scheduled-plans/PRD_AUTHORING.md) —
  rules from two real stuck-job incidents + a pre-queue checklist (§10).
- **PRD-write + destructive-git guards: adopt by REFERENCE, never vendor** — other repos point at THIS
  repo's absolute `scripts/hooks/guard-*.cjs`; New Epic's readiness banner installs both.
- A job parked in `needs_review` is a **question**, routed back to the authoring Epic — it never creates
  work on its own.
- The Scheduler nav row is **PROJECT-face only** — every route it renders is cwd-derived.

## Conventions

Full list + the incident behind each: [`conventions.md`](session-manager-operations/architecture/conventions.md).

- **Tab ID = claudeSessionId** by design (`--session-id` pass-through + JSONL lookup).
- **No CommonJS in renderer, no ES modules in main** — `.cjs` for main/preload bypasses `type: module`.
- **No backwards-compat shims** — single-author project; just rename and refactor.
- **Privacy invariant**: `RecordingStatus` MUST be mounted on the TOP z-ladder rung whenever `isRecording === true`.
- **One global z-ladder, `lib/zLayers.ts`** — values are class-name string literals, never interpolated
  (Tailwind JIT scans source text). Guarded by `lib/__tests__/zLayers.test.ts`.
- **No per-OS UI chrome** — native frame on every platform; no layering branches on `process.platform`.
- **Toast is the user-facing error channel** — `useToast().show('error', msg)`; never swallow errors.
- **Renderer stores are islands** — no cross-store subscription; compose selectors per component.
- **`--model` must be pinned explicitly** on every `claude -p` / `claude --print` call site. Unpinned calls
  inherit a drifting CLI default and silently multiply automation cost.

## Avoid

Each of these is a real incident, with the post-mortem in
[`conventions.md`](session-manager-operations/architecture/conventions.md) — read it before working around one.

- Launching a `claude -p` process **without acquiring a slot from `lib/sessionSlots.cjs`** — the single
  machine-wide concurrency limit — never reintroduce a private cap.
- Gating scheduler batches on **`parallelGroup`** — it's a unique-per-PRD display hint, never a barrier.
  `dependsOn` is the sole ordering primitive.
- **Returning a freshly-built value from a zustand selector** (`?? []`, `.map(...)`, `Object.values(...)`) —
  infinite re-render → React #185 → **the whole app renders blank**. Three incidents. `npm run lint:selectors`.
- **Declaring a hook below a top-level early return** — React #300/#310 → the pane dies into its error
  boundary. `npm run lint:hooks`.
- Adding `shell: true` to `child_process.spawn` outside `watchers.cjs` / `app:test-fire-hook`.
- Re-implementing tmp+rename atomic writes — use `config.cjs`'s `writeJson` / `writeTextAtomic`.
- Reading remote URLs in prod — `createWindow` hard-fails if `dist/index.html` is missing.
- Adding a new LeftNav tab before checking whether an existing surface owns that data — pruned once already
  after growing to ~31 destinations with real overlap.
- Adding pane-specific state to parent tabs, or importing design primitives via wildcard.

## Distribution

Published as `claude-code-session-manager` on npm (`npx claude-code-session-manager@latest`). `bin/cli.cjs`
spawns the bundled Electron binary; `postinstall` runs `electron-rebuild` for `node-pty`. Linux+darwin only.

**Simple mode**: `--simple` boots a chrome-free single-terminal cockpit (`app:launch-mode` IPC →
`SimpleShell.tsx`, `DEFAULT_PRESETS[0]`; no persisted-tab hydration).
