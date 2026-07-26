# Inbound feedback — session-manager

This folder is the intake queue for improvement requests, bug reports, and enhancement ideas for **claude-code-session-manager** — written by humans, other agents, or other projects. Items dropped here get processed end-to-end (evaluated → implemented or declined with reasons → published to git → archived), typically via `/process-feedback`.

## How to submit

Create **one file per item** in this folder:

```
session-manager-operations/feedback/<yyyy-mm-dd>-<kebab-slug>.md        e.g. session-manager-operations/feedback/2026-06-10-scheduler-pause-banner.md
```

Don't append to existing files, don't bundle unrelated asks into one file, and don't edit items already in `processed/`.

### Required frontmatter

```yaml
---
title: <one line, imperative: "Show pause reason in WindowStrip">
source: <who/what wrote this: "bilko", "signal-builder agent", "web-remote relay logs">
type: bug | enhancement | performance | security | docs
severity: blocker | high | normal | low
---
```

### Required body sections

```markdown
# What happens / what's missing

Concrete observed behavior or gap. For bugs: exact steps, the tab/feature name,
and what you expected instead. Paste error text verbatim — don't paraphrase it.

# Evidence

File paths + line numbers if you have them (src/main/scheduler.cjs:1505),
log excerpts (~/.claude/session-manager/*.log), screenshots (reference a path),
or the transcript/session id. An item with evidence gets fixed in one pass;
an item without it gets a diagnosis round-trip first.

# Suggested direction (optional)

Your idea for the fix. Clearly marked as a suggestion — the implementer may
take a different route if the codebase conventions say so.
```

## What makes feedback land well here

- **One observable problem per item.** "Scheduler shows stale utilization AND the KG tab is slow" is two files.
- **Name the surface precisely.** This app has 25+ tabs; "the list view" is ambiguous. Say `Scheduler tab → Queue sub-tab` or name the component (`SchedulePanel`, `WindowStrip`, `AgentView`).
- **Severity honestly.** `blocker` = data loss, crash, security hole, or a feature unusable with no workaround. Crying blocker on cosmetics gets your source's future items discounted.
- **State the environment when it matters.** OS (Pop!_OS / macOS), app version (`npm ls claude-code-session-manager` or the npx tag), whether the scheduler/web-remote was active. This project ships to 10k+ npx users on Linux + darwin — platform-specific reports must say which.
- **For agents filing feedback:** include the absolute paths you actually verified, not paths you inferred. If you ran a command to reproduce, paste the command and its real output.

## What does NOT belong here

- **Scheduled work / PRDs** — those go to `~/.claude/session-manager/scheduled-plans/prds/` (see `PRD_AUTHORING.md` there). Feedback describes a problem; a PRD prescribes work. If your item is already a fully-scoped work order, write a PRD instead.
- **Secrets** — no tokens, OAuth credentials, or `~/.claude/.credentials.json` contents in evidence. Redact before pasting logs.
- **Questions** — this is a work queue, not a discussion board. Unanswerable items get archived with a note.

## Lifecycle

1. **Open**: file sits in `session-manager-operations/feedback/`.
2. **Processing**: the processor reads every open item, implements accepted ones (code + tests + typecheck), declines others with written reasons.
3. **Processed**: item is moved to `session-manager-operations/feedback/processed/` with a `## Resolution` section appended — what shipped (commit/PR), or why it was declined. The file is never silently deleted.
4. **Lessons**: recurring submission problems (vague repro, wrong folder, bundled asks) get folded back into this README so the next submitter does better.

## Status log

| Item | Status | Outcome |
|---|---|---|
| 2026-06-10-01-verdict-scanner-false-positive-importerror | ✅ | Asks 1/2/4 shipped (anchored detectors + Task-result exemption, 4 regression tests); ask 3 (success-veto) declined — would neuter true-positive detection. Two Self jobs retagged completed. |
| 2026-06-10-02-verdict-recovered-env-probes-and-precedence | ✅ | Shipped: `Traceback→ModuleNotFoundError` reclassified as `verify_unavailable`; that class success-gated (recovered env probes annotate, don't downgrade) while real `transcript_errors` still hard-flag; commit-guard now always runs + materially-checkable verdict outranks pattern hits (carried as annotations). 4 tests, live re-scan of all 3 cited logs → clean. Stuck jobs auto-heal on boot reverify. AC-exit-code half deferred (no PRD-AC spec). |
| 2026-06-14-01-definition-of-done-on-queue-drain | ✅ | Shipped: PRDs 108–111 all completed exitCode=0; `dodDrainHook.cjs` wired at drain, 5+ reports confirmed on disk. Queue drain now produces an audit without human trigger. |
| 2026-06-15-01-self-restart-orphans-cross-project-prds | ✅ | `4c5013c` fixed the live-kill path; PRD 320 fixed the boot-reconciliation path (`ORPHAN_REQUEUE_CAP` 2→5), verified landed (`43a70ba`) 2026-07-10. Both code paths closed. |
| 2026-06-27-01-high-quality-develop-and-find-opportunity | 🛠 partial | Ask 1 (`/find-opportunity` skill) shipped directly 2026-07-10 (instruction-file edit, no PRD needed). Asks 2 (`quality: high` tier) and 3 (conventions loop) deferred — genuine open design questions the filer left for bilko's call; not queued. |
| 2026-07-03-url-browser-pane-with-dom-recording | 🛠 in flight | Already covered by the existing Browser-tab PRD chain (402–413: panel scaffold, picker/capture/screenshot, recorder engine/panel/replay, persistence, e2e+docs). No new PRD needed. Verification currently blocked on 2026-07-10-01's fix (403–406 falsely show completed). |
| 2026-07-10-01-scheduler-marks-jobs-completed-without-landed-commit | 🛠 queued (PRD 1) | Root-caused: `runVerify.cjs`'s verdict scanner only flags positive pattern hits, never checks for "no sentinel + no commit" (a run that does nothing sails through as clean). PRD `1-verdict-scanner-require-sentinel-or-commit` queued at low parallelGroup (1) to preempt the queue. Manually resetting 403–406 is left to bilko (Scheduler tab UI, not automatable safely from outside the running app). |
| 2026-07-10-02-fullscreen-agent-browser-split-layout | 🛠 queued (PRD 533) | Core split + fullscreen toggle (agent left 1/3, Browser right 2/3) queued as `533-fullscreen-agent-browser-split-layout`. Report's `AgentView.tsx` citation didn't exist — corrected to `TerminalChat.tsx`/`Terminal.tsx` in the PRD. Anchored action-button row deferred to a follow-up. |
| 2026-07-12-gh-issue-1-modal-text-overflow | 🛠 queued (PRD 542) | Sourced from GitHub issue #1 via the new step-0b GitHub-issue sync. Root-caused: `Modal.tsx` has zero overflow-wrap/word-break CSS (confirmed via grep). Queued as `542-modal-text-overflow-wrap`. |
| 2026-07-12-gh-issue-2-rich-data-table-rendering | 🛠 queued (PRD 543) | Sourced from GitHub issue #2. Design decision made during triage: reuse GFM markdown table syntax (already parsed by `marked`) instead of the issue's proposed custom `:::table`/JSON format. Queued as `543-chat-mode-data-table-rendering`, sequenced after PRD 542's sibling (same file). |
| 2026-07-12-gh-issue-3-chat-mode-text-formatting | 🛠 queued (PRD 542) | Sourced from GitHub issue #3. Root cause genuinely undetermined at triage (marked GFM-list config vs. CSS whitespace) — queued as `542-chat-mode-markdown-formatting` with an explicit reproduce-before-fix requirement rather than guessing. |
| 2026-07-15-gh-issue-4-prd-number-collision | 🛠 queued (PRD 548) | Sourced from GitHub issue #4. Premise confirmed (`develop/SKILL.md:76` is the cited command; the prds dir is one global namespace). Filer's Option A (per-project filename namespacing) **rejected** — breaks `parallelGroup` parsing (`prdParser.cjs:92`, `scheduler.cjs:2528`) across 577 PRDs despite the issue claiming backward compatibility. Queued as `548-atomic-prd-parallel-group-allocation` (Option C hardened to atomic allocation, reusing `config.cjs` tmp+rename). **Second live reproduction captured during triage** — a `~/Projects/sigma` PRD and three session-manager PRDs both allocated 545 concurrently; folded in as the regression fixture. Refined diagnosis: the real failure is silent parallel-group *merging*, not the "lost work/overwrite" the issue claims. |
| 2026-07-15-gh-issue-5-project-prd-automation-hooks | 🛠 queued (PRD 550) | Sourced from GitHub issue #5. Option A (project-supplied `automation-hooks.js` run in-process on a timer) **declined on security grounds** — inverts `validatePath`/zod-IPC/no-`shell:true` invariants. Option B folds into PRD 549 (not re-filed — would fork the design). Option C (document the pattern) queued as `550-document-external-prd-queueing-pattern`, sequenced after 549. Two of the filer's three questions already had in-repo answers never written down. |
| 2026-07-15-gh-issue-6-scheduler-mcp-create-prd | 🛠 queued (PRD 549) | Sourced from GitHub issue #6. **Premise partly wrong** — the MCP server it asks to create already exists (`scripts/scheduler-mcp-server.cjs`, in `.mcp.json`). Genuine delta = one tool + one route, queued as `549-scheduler-create-prd-admin-route-and-mcp-tool` (depends on 548). Declined: `scheduler_watch_prd` (blocking in-agent poll loop = the fizzpop anti-pattern; would occupy 1 of 3 concurrency slots idle), `scheduler_list_prds` (exists as `scheduler_list_jobs`). Deferred: `get_status`/`update`/`cancel` (no live use case; `adminServer.cjs:17` keeps the surface narrow deliberately). Kept the filer's best idea: append the standards block server-side. |
| 2026-07-15-gh-issue-7-close-other-tabs | 🛠 queued (PRD 545) | Sourced from GitHub issue #7. **Premise almost entirely wrong — 4 of 5 Must-Have AC already shipped**, including the unsaved-changes guard (`EditorView.tsx:183-198`) and path-keyed correctness (`editor.ts:110-115`); the context menu with Close Others/Close All is at `FileTabBar.tsx:81,124-138`. Queued only the real gap (`Ctrl/Cmd+Shift+W` + Close-to-the-Right) as `545-editor-tab-close-shortcut-and-close-right`. A 12-min change presented as a 12-point checklist. |
| 2026-07-15-gh-issue-8-show-hidden-files-default | 🛠 queued (PRD 545) | Sourced from GitHub issue #8. **Premise wrong** — the `showHidden` filter (`files.cjs:68,77`), IPC plumbing (`preload/index.cjs:221`), eye-icon toggle (`FileTree.tsx:473-477`) and muted dotfile styling (`:655`) all already ship. Reshaped to the two real gaps (default → `true` at `FileTree.tsx:135`; persist the choice, which the issue never names) as `545-filetree-show-hidden-default-and-persist`. Declined: removing the filter (it *is* the toggle), icon sets, `.DS_Store` denylist. |
| 2026-07-18-needs-review-false-positive-on-externally-completed-prd | 🛠 queued (PRD 575) | Filed from a sigma-project session; root cause lives in session-manager's own verifier. Confirmed live against current code: `runVerify.cjs`'s `pass_no_commit` check (~line 645) only exempts fix-plan jobs (`^\d+-fix-`), not the `-merge-main` convention the 5 cited jobs use — `scheduler.cjs`'s own `RESCANNABLE_VERDICTS` doc comment confirms rescanning `pass_no_commit` is a no-op for non-fix-plan slugs today. Ask 1 (soften the verdict via an independently-checkable postcondition) queued as `575-verifier-merge-postcondition-exemption` (`gh pr view` re-check, narrowly scoped to `-merge-main` slugs only, safe fallback on any `gh` failure). Ask 2 (safe way to resolve a stale `needs_review`/`failed` job without hand-editing `queue.json`) was already answered by an existing-but-undocumented mechanism (`queueOps.cjs`'s `archiveMany` + `reconcile()`'s drop-on-missing-file behavior) — confirmed working live twice in the same session (archived `561-fix-fix-global-chrome-frame-review` and the redundant `565-terminal-review-fix`/`565-fix-terminal-review-fix` pair); documented as `PRD_AUTHORING.md` §15 instead of new code. |
| 2026-07-21-agent-persona-registry-and-sync | 🛠 queued (PRD 675) | Piece 1 (drift + integrity check on `~/.claude/CLAUDE.md`'s `@import` chain) queued as `675-persona-import-drift-health-check`, wired into `npm run health` as an informational component. Pieces 2 (scheduled pull) and 3 (persona SHA on job metadata) deferred — the filer's own "piece 1 alone would be worth shipping" framing, and both remaining pieces have open design questions not resolvable at triage. |
| 2026-07-21-chat-background-shell-false-promise | 🛠 queued (PRD 673) | Ask 1 (tell the agent Chat mode is one-shot, no background survival) queued as `673-chat-background-shell-mode-truth-preamble` — new instruction constant prepended to every Chat prompt in `chatRunner.cjs`, alongside the existing `STOP_SIGNAL_INSTRUCTION`. Ask 2 (visible "still running" banner) deferred as a separate, larger renderer feature; root-cause fix ships first. |
| 2026-07-21-develop-skill-default-design-source-priority | ✅ shipped directly | Pure `standards.md` instruction-file edit (no PRD, no build/test surface) — added a "Visual design" section codifying user-brief > existing-theme > design-skill priority, and requiring both light AND dark mode be rendered/screenshotted before UI work is called done. |
| 2026-07-22-pass-no-commit-false-negative-on-branch-hopping-prd | 🛠 queued (PRD 674) | Confirmed live: the live commit-guard (`scheduler.cjs:1702-1733`) only diffs `gitHead()` on the job's own branch, while the re-verify path already uses the more thorough `committedInWindow()` (scans `git log --all`). Queued `674-commit-guard-cross-branch-fallback` to make the live guard fall back to the existing helper — reusing it, not forking it — when the fast path finds nothing. |

## Lessons for submitters (kept current)

- **The gold standard so far**: `2026-06-10-01` — exact file:line of the offending code, two on-disk run logs as reproducible fixtures, a proposed acceptance test ("re-run scanner on these logs → clean; synthetic real error → still flags"). It was processed in one pass with zero diagnosis round-trips. Imitate it.
- **The enhancement exemplar**: `2026-06-14-01` — proper YAML frontmatter, the exact drain-point `file:line`, a no-human-trigger acceptance test, AND a real incident (the 81–85 money-path drain) for priority. It triaged straight to a `/develop` PRD chain with zero round-trips. An enhancement lands fastest when it names the precise hook site + a testable "done" + the cost already paid. Note: a suggestion's "mechanism options" are *options* — the implementer may pick a safer route (here: in-process gate over a spawned meta-job, to avoid a self-retrigger loop).
- **Propose asks separably.** Item 01 bundled 4 asks; 3 shipped, 1 was declined. That worked because each ask was independently actionable — keep doing that rather than one monolithic "redesign X".
- **Use the frontmatter.** Item 01 used an ad-hoc header instead of the YAML frontmatter above; it was rich enough to process anyway, but machine-readable `type`/`severity` is what future triage sorts by.
- **A follow-on is a NEW file, not a re-used name.** Item `-02` was filed by overwriting item 01's exact filename with an "## Addendum". That collided with the already-processed copy and nearly got lost. New observations after an item is closed → a fresh `<date>-NN-<slug>.md`; reference the prior item in the body instead.
- **What made `-02` close in one pass**: it named the real run-log dirs (still on disk under `~/.claude/session-manager/scheduled-plans/runs/`) AND the masked-vs-noise distinction (commit-guard = material, traceback = pattern). Re-scanning the cited logs live was the whole proof. When a verdict/verifier bug is reported, cite the exact `runs/<ISO>/<slug>.log` so the implementer can re-scan before/after — that is this queue's gold-standard reproducer.
- **Distinguish "verification failed" from "verification couldn't run".** A `ModuleNotFoundError`/`ImportError` (even inside a Traceback) is the latter — an environment probe, not a logic failure. Don't file those as `severity: high` failures; they downgrade only when the run *also* failed to reach success.
- **When a bug spans two code paths, name BOTH.** Item `2026-06-15-01` described one symptom (orphan retry exhaustion) but it has two code paths: the live-kill transient path AND the boot-reconciliation orphanRetries path. Commit `4c5013c` fixed one; the other needed a separate PRD. When filing a bug about retry exhaustion or re-queue logic, state which code path(s) you traced (live vs boot-reconciliation) so the fixer knows both branches need attention.
- **"Addresses" in a commit message may mean "partially addresses"** — the triage pass re-checks the acceptance criteria against the current code, not just the commit message. Don't mark an item ✅ based on the commit message alone; verify the AC mechanically.
- **`queue.json` "completed" is not proof of "landed."** `2026-07-10-01` found the verifier can mark a run `completed, exitCode: 0` when the agent made zero changes and just asked a question. Before citing a PRD as done in a RESOLUTION (either to close an item or to say "already covered by X"), cross-check `git log` for a real commit — don't trust `status` alone. This applies retroactively to any item whose RESOLUTION only cites a PRD id without a commit hash.
- **A queued PRD that's "already in flight" doesn't need a NEW PRD.** `2026-07-03` turned out to already be covered by an existing, unrelated-looking PRD chain (the Browser tab work). Before decomposing a fresh implementation, check whether the ask is already mid-flight under a different name/slug — grep `queue.json`/`prds/` for the feature area, not just the item's own suggested filenames.
- **Open, filer-flagged design questions ("your call") are a reason to defer, not to guess.** `2026-06-27-01` had 2 of its 3 asks left genuinely undecided by the filer. Ship the independently-specified part (here: Ask 1, standalone-useful), defer the rest with the specific open questions named in the RESOLUTION rather than picking an answer during triage — a wrong guess on a whole new skill/mode costs more than the wait.
- **Open the surface before describing it — "currently there is no way to X" is a claim, not context.** The 2026-07-15 GitHub round was the worst case so far: **4 of 5 items had materially wrong premises.** gh-issue-7 asked for a bulk tab-close that already shipped, guard modal and all (4 of its 5 Must-Haves were done); gh-issue-8 asked to un-hide dotfiles when the toggle, the IPC and the muted styling already existed; gh-issue-6 asked to create an MCP server that is already registered in `.mcp.json`. Each was written from memory of the product rather than from the code. **One grep would have caught every one.** An item whose premise is wrong isn't free to process — it costs a full verification pass and then gets rewritten into something 10× smaller. Before filing: grep for the feature, name what you found, and describe the *delta*.
- **Size the ask to the delta, not to the feature.** gh-issue-7 shipped a 12-point implementation checklist, success metrics, and 4 user flows for what turned out to be one keybinding (~12 min). gh-issue-8 did the same for a one-line default change. Long PRD-shaped issues *look* rigorous but anchor the estimate wrong and bury the 5% that's real. If you can't state the delta in two sentences, you probably haven't found it yet. (Also: a fully-scoped work order belongs in `prds/`, not here — see "What does NOT belong here".)
- **Don't propose acceptance criteria that can't be evaluated.** Both gh-issue-7 and gh-issue-8 set "success metrics" like "60%+ of users with 10+ tabs use this within 30 days" and "90%+ of users locate hidden files in 10 seconds". This project ships to npx users and has **no usage telemetry** — those numbers are unmeasurable, so they were dropped at triage. Propose AC a machine or a human can actually check.
- **A suggested fix must be checked against the code it would break.** gh-issue-4 recommended renaming PRDs to `<project-slug>-<NN>-<slug>.md` and listed "backward compatible (just read existing format)" as a pro. It isn't: `NN` is parsed as the *leading digits* to derive `parallelGroup`, so the rename breaks scheduling for every new PRD and orphans 577 existing ones. The problem was real and well-evidenced; the recommended solution was rejected outright. **File the problem with evidence; mark the solution as a suggestion** (this folder's frontmatter already says "the implementer may take a different route") — and if you do recommend one, verify the compatibility claim you're making about it.
- **Overlapping items get merged, so cross-reference instead of re-filing.** gh-issue-4 (NN collisions) and gh-issue-6 (an MCP create tool) were the same root cause, and gh-issue-5's only real blocker was gh-issue-6's tool. They triaged into one PRD chain (548 → 549 → 550). When your item depends on or restates another, say so — filing the same design twice forks it.
- **Verify component names cited in a report actually exist before trusting them into a PRD.**
  `2026-07-10-02` cited `AgentView.tsx` (per this README's own "name the surface precisely"
  example, ironically) — that component doesn't exist in this codebase; the real surface is
  `TerminalChat.tsx`/`Terminal.tsx`. A grep-before-trust pass on every file:line citation caught it
  before it reached the headless executor as a dead reference. Filed reports describe the world as
  the filer understood it, which can be stale or approximate — always re-verify against current
  code during triage, not just for the root cause but for every specific name cited.
- **Authoring a new SKILL.md is not "code" for `/develop` purposes.** A brand-new skill file with no build/test surface (`find-opportunity`) was authored directly as part of this triage pass, same as editing an existing `SKILL.md`/`CLAUDE.md` — routing pure-markdown skill authorship through the scheduler is overhead with no safety benefit. Application code (IPC, renderer, main-process logic) still always goes through `/develop`.
- **GitHub issues are now a first-class feedback source, not just human/agent-filed files.** `2026-07-12`: added a step-0b sync that pulls open GitHub issues on the project's own repo into this intake (deduped via a `gh-issue-<N>` token in the `source` field), before the normal triage pass runs. All 3 open issues at the time were already well-specified (clear problem/expected-behavior/proposed-solution structure) and triaged in one pass with zero round-trips — GitHub's own issue template did the same job this folder's frontmatter does. When two sourced issues touch the same file (here: #2 and #3 both hit `TerminalChat.tsx`), sequence their PRDs (different `NN`) rather than same-group-parallel — a same-file concurrent edit is a real, previously-observed failure mode (2026-07-12 scheduler-concurrency incidents), not a hypothetical.
- **Working-tree corruption can predate your own pass — check before you build on existing uncommitted state.** Found `README.md` sitting with a mangled status-log table (whitespace/pipes stripped from a prior uncommitted edit, source unclear) before this pass touched it. `git diff` against the last commit made it obvious; `git checkout --` the file restored the last-known-good version before adding this round's rows. Don't assume uncommitted state in a shared file is either "mine" or "safe" — diff it first.
- **A feedback item about `/develop`'s own standards is itself a `standards.md` edit, not application code.** `2026-07-21-develop-skill-default-design-source-priority` asked `/develop` to carry a new rule — the natural instinct is to queue a PRD, but the "target" here is `plugins/session-manager-dev/skills/develop/standards.md`, a pure markdown instruction file with no build/test surface. Same class as the `find-opportunity` SKILL.md precedent already in this log: edit it directly, in the same pass, and record the resolution — don't burn a scheduler slot on prose that has nothing to typecheck or test.
- **When a bug report distinguishes the "fast path" from a "more thorough path" already used elsewhere in the same file, that's the fix, not a hint toward one.** `2026-07-22`'s commit-guard report named both the buggy live check (`gitHead()` before/after) and the correct-but-unused-here helper (`committedInWindow()`, already called at a different line in the same file for the re-verify path). The PRD is "wire A to fall back to B," not "design a new detector" — cite both line numbers so the executor reuses instead of reinventing.
- **A three-piece suggestion doesn't need all three pieces solved to be worth filing — take the filer's own priority ranking at face value.** `2026-07-21-agent-persona-registry-and-sync` proposed 3 pieces and explicitly said "piece 1 alone would be worth shipping without 2 or 3." Queue piece 1, defer 2/3 with the open design questions named (same pattern as `2026-06-27-01`'s deferred asks) — don't force a decision on the unresolved pieces just because the item arrived as one file.

## Conventions the implementer will hold your suggestion to

If you propose a fix direction, know the house rules (full set in `CLAUDE.md`):
- Errors surface to the user via Toast (`useToast().show('error', ...)`) — never swallowed.
- Renderer zustand stores never cross-subscribe; composition happens in components.
- All fs paths go through `validatePath`; atomic writes via `config.cjs` helpers.
- Max 3 concurrent `claude -p` jobs on this machine — don't propose designs that fan out wider.
- No backwards-compat shims; rename and refactor cleanly.
