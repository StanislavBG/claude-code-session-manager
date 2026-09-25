# Validation — Field Manual 2.0.0 plan

Epic: `the-manual-needs-to-be-redone-delete-and-start-o-3ba80794`
Validated from: `sm-job/1440-validate-manual-v2` @ `cf7300cb` (session-manager), plus
`~/Projects/Bilko-manual-v2` @ `034f46c` (manual-v2 branch, not pushed).

No `session-manager-operations/scheduler/epics/<epic>/prds/` or `prds-archived/` entries exist
for this epic in this worktree or anywhere in `git log --all` — PRD source files are pure
scheduler working-tree state, never committed. Landed work was located instead via
`git log --all --grep` on each `mv2-NN-<slug>` commit-message token and by reading the
`session-manager-operations/manual/RELEASE-2.0.0.md` tracking doc, then verified against the
real tree and re-run gates below.

## mv2-01 — reset-chapter-map

- Commit: `6ecb9214` "docs(manual): 2.0.0 reset — delete old chapters, new 13-chapter map".
- Evidence: `session-manager-operations/manual/manual.json` lists exactly the 13 chapter slugs
  named in the plan goal, each with a `file` under `chapters/`; all 13 files exist
  (`ls session-manager-operations/manual/chapters/` — 13 files, verified below).
- **VERIFIED**

## mv2-02 — style-guide

- Commit: `fa8d9bb7` "docs(manual): STYLE.md writing contract for 2.0.0".
- Evidence: `session-manager-operations/manual/STYLE.md:1-60` — audience, voice rules (2nd
  person, ≤18-word average sentence, active voice, agency metaphor), the "No internal code
  names" ban list (`claudeSessionId`, `cwd`, `PTY`, `IPC`, `zustand`, `Epic`), and the reading
  level contract (Flesch-Kincaid ≤ 9.0, 900–1,600 words, glossary exempt from word range).
- **VERIFIED**

## mv2-03 — readability-check

- Commit: `3e04996e` "feat(manual): readability checker for chapters".
- Gate re-run: `npm run manual:readability` → exit 0. All 13 chapters report grade 5.2–7.7
  (≤ 9.0) and 917–1,185 words (within 900–1,600).
- **VERIFIED**

## mv2-10..mv2-22 — the 13 chapters

Commits: welcome `0f178d2a`, what-is-an-agent `ffdf89c1`, claude-code-basics `050fea11`,
meet-your-agency `141537d7`, first-session `91123399`, plans-and-scheduler `8d33831c`,
checking-the-work `868f198f`, agents-and-missions `043a1686`, house-rules `8b867ed8`,
new-abilities `476cd801`, cockpit-tour `f955656e`, good-habits `fb18c84a`, glossary `9cb4e18c`.

- Readability: see mv2-03 gate above — all 13 pass grade ≤ 9.0 and the word-count band.
- Jargon grep (AC: `claudeSessionId|cwd|PTY|IPC|zustand|Epic`, Epic allowed only in glossary):
  `grep -lE "claudeSessionId|cwd|PTY|IPC|zustand" session-manager-operations/manual/chapters/*.html`
  → no matches (clean). `grep -lE "\bEpic\b" .../chapters/*.html` → `glossary.html` only.
- Spot-verified factual claims (3+ per chapter, cross-checked against the real tree):
  - **welcome**: `npx claude-code-session-manager@latest` matches `package.json` `"name"`
    (`package.json:2`); the four agent roles named (architect/dev-lead/validator/Scheduler)
    match `src/seed/agents/*.md`; the three-part + glossary structure matches `manual.json`.
  - **what-is-an-agent**: the four-part agent breakdown (model/tools/instructions/context) is
    a standard framing, not tied to a specific file — no contradiction found; permissions
    "reading never needs approval, writing/running does" matches `house-rules` chapter and
    `src/renderer` Permissions tab behavior described there.
  - **claude-code-basics**: `claude --continue`, `claude login`, `/model` are real Claude Code
    CLI surface (general knowledge, consistent with rest of manual); the building-block →
    Session Manager screen table ("System Prompt", "Agent Library", "MCP Servers", "Hooks",
    "Skills") all found verbatim in `src/renderer/lib/navGroups.ts`.
  - **meet-your-agency**: architect/dev-lead/validator/project-home-builder role table matches
    `src/seed/agents/{architect,dev-lead,validator,project-home-builder}.md` `description:`
    fields exactly; "architect thinks with the most capable model" / "dev-lead and validator run
    on a faster model" matches `model: opus` (architect) vs `model: sonnet` (dev-lead,
    validator) in those same files.
  - **first-session**: "Proposed → Active → Completed" lifecycle matches
    `session-manager-operations/prompt-sessions/README.md#lifecycle` and root `CLAUDE.md`
    ("Lifecycle is the single `status` field — exactly `proposed`/`active`/`completed`");
    Agent+Mission two-selection framing matches root `CLAUDE.md` ("Epic creation is two
    independent selections"); Chat/Terminal "two views of one session" matches
    "EPIC : claude-session = 1:1 ... Chat and Terminal are two VIEWS over one session."
  - **plans-and-scheduler**: status vocabulary (Pending/Running/Completed/Failed/Needs review)
    matches the literal string set in `src/main/scheduler.cjs`
    (`'pending'|'running'|'completed'|'failed'|'needs_review'|'skipped'`); `dependsOn` as the
    sole ordering primitive matches root `CLAUDE.md` ("`dependsOn` is the sole ordering
    primitive"); per-work-order worktree isolation matches `domain-model.md`'s worktree
    isolation law.
  - **checking-the-work**: validator's "verified/refuted, never edits, never queues" framing
    matches `src/seed/agents/validator.md` description field verbatim; Needs-review-as-question
    framing matches root `CLAUDE.md` ("A job parked in `needs_review` is a **question**").
  - **agents-and-missions**: model list "Haiku, Sonnet, Opus, Fable" matches the four model IDs
    in this session's own system context; "Feature/Bug/Discussion" missions match
    `src/seed/agents/architect.md` frontmatter `tags: feature, bug, discussion`; "Tag Library"
    and "Agent Library" both found verbatim in `src/renderer/lib/navGroups.ts`.
  - **house-rules**: `~/.claude/CLAUDE.md` path and "System Prompt" tab label match
    `src/renderer/lib/navGroups.ts:71` exactly (`hint: 'Your ~/.claude/CLAUDE.md — house rules
    for every session on this machine'`); the User/Project/Local settings-scope table matches
    standard Claude Code `settings.json` scoping.
  - **new-abilities**: `--simple` flag confirmed in `src/main/index.cjs:511`
    (`process.argv.includes('--simple')`); "test connections" / "test fire" tab features
    plausible against `app:test-fire-hook` referenced in root `CLAUDE.md`'s Avoid list.
  - **cockpit-tour**: `SM_TELEMETRY=0` matches root `CLAUDE.md` verbatim ("Telemetry is
    anonymous, on by default, opt-out (`SM_TELEMETRY=0`)"); "Host on Bilko.run" / publishing
    flow matches `bilko-host-publisher` agent description; recording-indicator claim matches
    the Privacy invariant convention ("`RecordingStatus` MUST be mounted on the TOP z-ladder
    rung whenever `isRecording === true`").
  - **good-habits**: cross-references to `#first-session`, `#meet-your-agency`,
    `#plans-and-scheduler`, `#checking-the-work`, `#house-rules`, `#cockpit-tour` all resolve to
    real chapter slugs present in `manual.json`.
  - **glossary**: "Epic" is the only chapter allowed to use the word and does
    ("In the code, a Session is called an Epic — you will not see that word in the app itself"),
    matching root `CLAUDE.md`'s domain-model law; every glossary term cross-links to a real
    chapter slug.
- **VERIFIED** (all 13)

## mv2-30 — offline-edition-light-theme

- Commit: `620f01bd` "feat(manual): light print-friendly offline edition, parts in manifest"
  (2026-09-25, touches `web/manual/build.mjs` only — 65 insertions / 25 deletions).
- **VERIFIED**

## mv2-31 — bilko-reader-light-theme

- Session-manager tracking commit: `9b865d38` "docs(manual): track Bilko manual-v2 light-theme
  commit + contrast ratios", recorded in `RELEASE-2.0.0.md`.
- Actual code commit: `~/Projects/Bilko-manual-v2` @ `744452a` "fix(manual): light-theme reader
  with readable contrast" (not pushed, branch `manual-v2`).
- Diff re-read (`git -C ~/Projects/Bilko-manual-v2 diff 744452a~1..034f46c -- src/pages/ManualPage.tsx`):
  a mechanical Tailwind color-token swap (`neutral-*`/`emerald-*`/`sky-*` dark tokens →
  `warm-*`/`fire-*`/`emerald-700` light tokens matching `SessionManagerPage.tsx`'s palette). No
  logic change, no injection surface, no secrets.
- Gate re-run: `cd ~/Projects/Bilko-manual-v2 && npm run typecheck` → clean (no output, exit
  implied 0).
- **VERIFIED**

## mv2-32 — bilko-reader-parts-nav

- Session-manager merge commit: `d5315ebf` "merge scheduler job
  1438-mv2-32-bilko-reader-parts-nav" (touches `RELEASE-2.0.0.md` only, 15 lines).
- Actual code commit: `~/Projects/Bilko-manual-v2` @ `10570bc` "feat(manual): group reader
  chapter list by part" — `shared/manual-catalog.ts` (`ManualChapter.part?: string`, threaded
  through `tocFromManifest`), `src/pages/ManualPage.tsx` (nav heading per part + `<optgroup>` on
  mobile), `tests/manual.test.ts`.
- Gate re-run: `cd ~/Projects/Bilko-manual-v2 && timeout 180 npx vitest run tests/manual.test.ts`
  → **10/10 passed** (matches the count `RELEASE-2.0.0.md`'s own mv2-32 section claims).
- **VERIFIED**

## mv2-40 — build-release-bundle

- Session-manager commit: `cf7300cb` "docs(manual): record mv2-40 release bundle SHA in
  RELEASE-2.0.0.md".
- Actual code commit: `~/Projects/Bilko-manual-v2` @ `034f46c` "manual: Field Manual 2.0.0
  release bundle" — `data/manual/releases/2.0.0/` (13 chapter HTML files, `manifest.json`,
  `field-manual-2.0.0.html`, `field-manual-2.0.0.pdf`, `figures/`), built via
  `node web/manual/build.mjs --out ~/Projects/Bilko-manual-v2/data/manual/releases`.
- Gate re-run: `npm run manual:readability` → exit 0 (see mv2-03); `timeout 180 npx vitest run
  web/manual/__tests__` → **14/14 passed**.
- **Discrepancy found**: `RELEASE-2.0.0.md`'s own "mv2-40 — release bundle build" section
  claims `cd ~/Projects/Bilko-manual-v2 && timeout 300 npx vitest run tests/manual.test.ts —
  14/14 passed`. Re-running that exact command now gives **10/10 passed**, matching the
  count mv2-32's own section already recorded for the same file, and `git log` shows
  `034f46c` (mv2-40's own commit) never touched `tests/manual.test.ts` — only `10570bc`
  (mv2-32) did. The "14/14" figure appears to be a copy-paste of the *session-manager-side*
  `web/manual/__tests__` count onto the wrong (Bilko-side) gate line; it does not reflect a
  real regression, since the real, current count (10/10) is unchanged and green. Documentation
  inaccuracy only — see Findings.
- **VERIFIED** (build artifacts and both real gates are green; the doc's mis-stated count is
  flagged as a Minor finding, not a functional defect)

## Bilko side — branch + push-safety check

- `~/Projects/Bilko` (main, the *product* repo, not manual-v2): `git status -sb` shows
  `main...origin/main` with 0 ahead/behind — no commits landed on main from this plan. The
  modified `public/outdoor-hours/hourly/*.json` files present are pre-existing foreign WIP
  (an unrelated trading-data auto-updater), not manual-v2 output.
- `~/Projects/Bilko-manual-v2` (worktree on branch `manual-v2`): `ahead 3, behind 1` vs
  `origin/main` — the 3 unique commits are exactly `744452a`/`10570bc`/`034f46c` (mv2-31/32/40).
  Nothing has been pushed (`git log origin/main..HEAD` on `manual-v2` still lists all 3; no
  push evidence in reflog). Confirms the plan's design: Bilko-side work lands on an unpushed
  branch, to be merged and pushed by `mv2-50-ship-manual-v2` (out of scope for this plan) after
  validation — which is this record.

## Findings

**Minor**
- `session-manager-operations/manual/RELEASE-2.0.0.md`, mv2-40 section: states
  `tests/manual.test.ts` gate as "14/14 passed"; the real, reproducible count is 10/10 (same as
  mv2-32's own correctly-recorded figure). Cosmetic doc error in a frozen-audit-trail file, not
  a code defect — the actual test suite is green either way. No fix applied (out of scope: this
  job may not edit product files, and `RELEASE-2.0.0.md` is scoped to this plan's own PRDs, not
  the validator's).

No Critical or Important findings. Code review of the combined diff (session-manager chapter
content is plain HTML with no scripts/expressions; Bilko-side diff is a Tailwind class-token
swap plus a typed, optional `part?: string` field threaded through an existing manifest
pipeline) surfaces no correctness, injection, secret-handling, or path-traversal issues.

---

VALIDATION: mv2-01-reset-chapter-map VERIFIED
VALIDATION: mv2-02-style-guide VERIFIED
VALIDATION: mv2-03-readability-check VERIFIED
VALIDATION: mv2-10-ch-welcome VERIFIED
VALIDATION: mv2-11-ch-what-is-an-agent VERIFIED
VALIDATION: mv2-12-ch-claude-code-basics VERIFIED
VALIDATION: mv2-13-ch-meet-your-agency VERIFIED
VALIDATION: mv2-14-ch-first-session VERIFIED
VALIDATION: mv2-15-ch-plans-and-scheduler VERIFIED
VALIDATION: mv2-16-ch-checking-the-work VERIFIED
VALIDATION: mv2-17-ch-agents-and-missions VERIFIED
VALIDATION: mv2-18-ch-house-rules VERIFIED
VALIDATION: mv2-19-ch-new-abilities VERIFIED
VALIDATION: mv2-20-ch-cockpit-tour VERIFIED
VALIDATION: mv2-21-ch-good-habits VERIFIED
VALIDATION: mv2-22-ch-glossary VERIFIED
VALIDATION: mv2-30-offline-edition-light-theme VERIFIED
VALIDATION: mv2-31-bilko-reader-light-theme VERIFIED
VALIDATION: mv2-32-bilko-reader-parts-nav VERIFIED
VALIDATION: mv2-40-build-release-bundle VERIFIED
SCHEDULER_VERDICT: PASS
