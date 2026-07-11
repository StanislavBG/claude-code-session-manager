---
title: Add a higher-quality dev loop — /find-opportunity + a quality:high tier on /develop
source: sigma agent (via /my-feedback)
type: enhancement
severity: normal
---

# What happens / what's missing

The `session-manager-dev` plugin's `/develop` runs **one** plan → implement →
verify-against-AC pass. That's right for most work, but for **high-stakes** items
(security, data-integrity, money/auth paths) a single pass under-delivers: it
fixes the reported symptom and misses adjacent failure modes, root causes, and
regression-proofing. There is also **no skill for choosing what to work on next
in a multi-contributor repo** — today that triage is ad-hoc.

Three project-agnostic gaps (nothing here is sigma-specific; sigma is only the
case study under Evidence):

1. **No `/find-opportunity` skill.** Picking the next task in a shared repo means
   reconciling open issues × open PRs × `main` and ranking by impact ÷
   conflict-risk. Done by hand it's error-prone — you miss that a PR already
   owns an issue (the link is often only in the PR *title*, not a `Closes #`
   line), or you pick work that collides with a hot file another PR is rewriting.

2. **`/develop` has no `quality: high` tier.** No structured way to spend more
   tokens *deliberately* for a better result: N independent plans → best
   combination → N adversarial validations with distinct lenses → ship only on
   pass. The current single-pass path is the only path.

3. **Code-review/owner lessons don't loop back into the project's conventions.**
   Recurring review findings and repo-owner corrections evaporate instead of
   sharpening the project's own `AGENTS.md`/`CLAUDE.md`.

# Evidence

**Target surfaces that would change (verified on disk):**
- `plugins/session-manager-dev/skills/develop/SKILL.md` + `develop/standards.md`
  — the single-pass pipeline + standards live here; the `quality: high` tier is a
  **mode on this skill**, not a fork.
- `plugins/session-manager-dev/skills/optimize-kpi/SKILL.md` — already implements
  the **token-budget + circuit-breaker + fan-out-N-recommenders** pattern the
  high-quality tier should reuse for its plan/validation fan-out and its stop
  condition.
- `plugins/session-manager-dev/skills/process-feedback/` — already folds lessons
  into a folder README; the "capture conventions" loop should reuse this
  mechanism, **not** a new doc, and **not** `/explain-to-me` (that's human-facing
  HUMAN_LEARN, not enforceable conventions).
- New skill dir would be `plugins/session-manager-dev/skills/find-opportunity/`.

**Live case study (sigma, 2026-06-27).** Working one issue ("a CSV export ignored
a list filter"):
- A normal `/develop` pass adds the missing param. The deliberate deep-check
  instead found the bug had a **second half** — the export's cache classifier
  didn't treat the filter as filtering, so a filtered export poisoned the shared
  unfiltered cache object (a variant of the repo's *own prior* cache-key issues)
  — plus the **root cause**: two filter-parsers that had drifted.
- Shipped the best of **3 diverse plans** (targeted / shared-parser /
  completeness-guard), not one in isolation.
- **3 adversarial validations with distinct lenses** (correctness /
  cache-security / completeness). Correctness and security passed; the
  **completeness lens earned its keep** — it found nothing tied the query's
  consumed filters to the declared key list, so a *future* filter could silently
  reopen the class. Closed with a compile-time guard before the PR (proven by
  injecting a stray field → `tsc` error).

Two properties — not raw token spend — were what made it quality, and they are
the design constraints:
- **Diversity, not redundancy.** Three identical reviewers all say "looks fine."
  Plans and validations must attack *different* failure modes.
- **Project-derived lenses.** The security lens was sharp only because it knew the
  repo's prior cache-key issues. A generic OWASP checklist misses it. The tier
  must read the target project's issue history / `AGENTS.md` / `docs/` to pick
  its plan axes and validation lenses.

# Suggested direction (optional — implementer's call)

**Ask 1 — `/find-opportunity` (new skill, shared repos).** Scan open issues ×
open PRs × `main`; score remaining by impact (priority/label/blast-radius) ÷
conflict-risk; output a ranked shortlist with per-pick reasoning **and** an
explicit excluded-list — no silent drops. Recommendation only; human picks.

**The skip rule is the heart of this skill, not a footnote.** Knowing what *not*
to pick is as important as ranking what to pick — a wrong pick wastes a full
high-quality `/develop` pass and risks a merge fight with a contributor. An issue
is **SKIPPED (not ranked)** when:
- **Already claimed by an open PR.** Match aggressively: a PR's `Closes/Fixes #N`
  body line, an `(#N)` in its **title**, a branch name, or a linked-PR field. (In
  the prototype session, issue #87 was claimed only via a PR *title* — a naive
  `Closes #` scan missed it and nearly produced a duplicate.)
- **Would conflict with an open PR's diff.** If resolving the issue would touch
  files an open PR is actively rewriting (high churn overlap), skip or defer —
  better to wait for that PR to merge than to fight it. Cold files (tests, a
  route the PRs don't touch) are safe; hot shared files (global stylesheet, a
  core module several PRs edit) are not.
- **Blocked / needs-decision / owned by someone.** `status: needs-decision`,
  assignee set, or a "discussion" label → not actionable solo; skip.

Every skip is reported *with its reason and the blocking PR #* — the skip-list is
a first-class output, so the human sees "left these alone because X," never a
silent omission.
- *Acceptance:* on a repo where an issue is claimed only via a PR **title** (no
  `Closes #`), that issue is SKIPPED with the PR # cited; an issue whose fix would
  touch a file in an open PR's diff is skipped/deferred with the conflicting PR #
  and file named; nothing is dropped without a stated reason.

**Ask 2 — `quality: high` tier on `/develop` (mode flag, not a fork).** Deep-check
(re-confirm the issue is unclaimed and non-conflicting — Ask 1's skip rule re-run
at execution time, since a PR can land between triage and start; abort cleanly if
it's now claimed) + root cause + adjacent modes → fan out N plans (default 3) on
different axes →
implement best *combination* → fan out N adversarial validations (default 3) with
distinct, **project-derived** lenses → gate ship on validations passing → PR to
the project's standards. Gating: opt-in per item, auto-suggested on high stakes
(priority:high / security / data-quality / money/auth/data), under a **hard token
ceiling + circuit-breaker** (reuse `optimize-kpi`'s budget pattern) that stops
cleanly and reports remaining work. N tunable (3 = diversity floor).
- *Acceptance:* invoking the tier on a seeded high-stakes task produces ≥3
  distinct plans, a combined implementation, ≥3 validations with *different*
  lenses, and refuses to open the PR if a validation fails; the run halts at the
  token ceiling with a "remaining" report instead of overrunning.

**Ask 3 — conventions loop (fold into `/process-feedback`, no new doc).**
Recurring review findings + owner corrections distil back into the target
project's existing `AGENTS.md`/`CLAUDE.md`.
- *Acceptance:* a repeated review finding shows up as an added rule in the target
  project's conventions file, not a new parallel doc.

**Composition:** `find-opportunity → develop(quality:high) → repeat` under the
token ceiling — an exhaustive "work the backlog well" loop, sibling to
`/optimize-kpi`. The asks are independently shippable; Ask 1 is the smallest and
useful on its own.

**Guardrail — the loop closes issues, it does not open them.** Its job is to
*resolve* existing work, not generate more tracking. The owner's rule: **by the
time you've specified an issue well enough to file it, you've already done the
analysis to fix it — so write the solution, not the issue.** When the loop
surfaces a follow-up or adjacent bug, the default is to **fold the fix into the
work in flight** (the current PR), not to write it up as a new issue. **Opening
any public / outward artifact — a GitHub issue, a new PR on a shared repo — is an
explicit human-sync gate, never automatic.** Only when a problem genuinely can't
be solved now (needs a decision, blocked on another team, out of scope for the
session) does the loop *propose* filing — and waits for the human to choose. It
must not open issues on its own. (Learned the hard way in the prototype session —
an auto-filed follow-up issue had to be closed and its fix folded into the active
PR instead.) Internal artifacts (a cross-project `/my-feedback` file, a local
note) are fine; anything that creates public tracking on a watched repo is gated.

**Open questions (your call):** flag surface (`--quality high` vs interactive
stakes prompt vs auto-trigger on labels); whether `/find-opportunity` is
standalone or only the loop's front-half (I lean standalone — triage is useful
alone); where validation lenses persist per project so they sharpen over time
(target's `AGENTS.md` vs a plugin-side cache keyed by repo).

## RESOLUTION

**Accepted, partial — "Ours, do it."** Verified against current code (2026-07-10): `/develop`
still runs a single plan→implement→verify pass, no `/find-opportunity` skill existed, no
conventions-loop existed. All three asks are legitimately session-manager's to build.

**Ask 1 (`/find-opportunity`) — shipped directly.** The filer's own recommendation ("I lean
standalone — triage is useful alone") is taken: authored
`plugins/session-manager-dev/skills/find-opportunity/SKILL.md` as a standalone skill
implementing the full spec — claim-matching against PR title/body/branch (not just `Closes #`),
diff-conflict detection against open PRs' touched files, blocked/needs-decision skip, and a
ranked-shortlist + exhaustive-reasoned-skip-list output shape. Registered in the plugin's
routing table (`~/.claude/CLAUDE.md`) and `plugin.json`. Done as a direct instruction-file edit
(no PRD) — a new `SKILL.md` has no build/test surface, so routing it through the scheduler would
be pure overhead.

**Ask 2 (`quality: high` tier on `/develop`) and Ask 3 (conventions-loop into
`/process-feedback`) — deferred, not queued.** Both have genuine open design questions the
filer explicitly left as "your call" (flag surface, where validation lenses persist,
loop composition) that materially change the implementation shape — guessing wrong here means
shipping a whole new `/develop` mode or `/process-feedback` behavior that has to be reworked.
Per this project's working style (ask before guessing on decisions that cost real rework, don't
ask permission for the obvious), this needs the project owner's call before it's queued, not a
unilateral design decision made during triage. Left open for a follow-up pass once bilko decides:
flag surface for `quality: high`, and where validation lenses should persist.
