# Inbound feedback — session-manager

This folder is the intake queue for improvement requests, bug reports, and enhancement ideas for **claude-code-session-manager** — written by humans, other agents, or other projects. Items dropped here get processed end-to-end (evaluated → implemented or declined with reasons → published to git → archived), typically via `/process-feedback`.

## How to submit

Create **one file per item** in this folder:

```
feedback/<yyyy-mm-dd>-<kebab-slug>.md        e.g. feedback/2026-06-10-scheduler-pause-banner.md
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

1. **Open**: file sits in `feedback/`.
2. **Processing**: the processor reads every open item, implements accepted ones (code + tests + typecheck), declines others with written reasons.
3. **Processed**: item is moved to `feedback/processed/` with a `## Resolution` section appended — what shipped (commit/PR), or why it was declined. The file is never silently deleted.
4. **Lessons**: recurring submission problems (vague repro, wrong folder, bundled asks) get folded back into this README so the next submitter does better.

## Status log

| Item | Status | Outcome |
|---|---|---|
| 2026-06-10-01-verdict-scanner-false-positive-importerror | ✅ | Asks 1/2/4 shipped (anchored detectors + Task-result exemption, 4 regression tests); ask 3 (success-veto) declined — would neuter true-positive detection. Two Self jobs retagged completed. |
| 2026-06-10-02-verdict-recovered-env-probes-and-precedence | ✅ | Shipped: `Traceback→ModuleNotFoundError` reclassified as `verify_unavailable`; that class success-gated (recovered env probes annotate, don't downgrade) while real `transcript_errors` still hard-flag; commit-guard now always runs + materially-checkable verdict outranks pattern hits (carried as annotations). 4 tests, live re-scan of all 3 cited logs → clean. Stuck jobs auto-heal on boot reverify. AC-exit-code half deferred (no PRD-AC spec). |
| 2026-06-14-01-definition-of-done-on-queue-drain | 🆕 open | Auto-run a definition-of-done gate (per-PRD AC re-verify + batch code-review + report) at queue-drain (`scheduler.cjs:1472` empty-batch branch), so "completed exit 0" becomes "verified+reviewed". From social-signals-trader; incident: 81–85 money-path batch drained green but ungated until a human asked. |

## Lessons for submitters (kept current)

- **The gold standard so far**: `2026-06-10-01` — exact file:line of the offending code, two on-disk run logs as reproducible fixtures, a proposed acceptance test ("re-run scanner on these logs → clean; synthetic real error → still flags"). It was processed in one pass with zero diagnosis round-trips. Imitate it.
- **Propose asks separably.** Item 01 bundled 4 asks; 3 shipped, 1 was declined. That worked because each ask was independently actionable — keep doing that rather than one monolithic "redesign X".
- **Use the frontmatter.** Item 01 used an ad-hoc header instead of the YAML frontmatter above; it was rich enough to process anyway, but machine-readable `type`/`severity` is what future triage sorts by.
- **A follow-on is a NEW file, not a re-used name.** Item `-02` was filed by overwriting item 01's exact filename with an "## Addendum". That collided with the already-processed copy and nearly got lost. New observations after an item is closed → a fresh `<date>-NN-<slug>.md`; reference the prior item in the body instead.
- **What made `-02` close in one pass**: it named the real run-log dirs (still on disk under `~/.claude/session-manager/scheduled-plans/runs/`) AND the masked-vs-noise distinction (commit-guard = material, traceback = pattern). Re-scanning the cited logs live was the whole proof. When a verdict/verifier bug is reported, cite the exact `runs/<ISO>/<slug>.log` so the implementer can re-scan before/after — that is this queue's gold-standard reproducer.
- **Distinguish "verification failed" from "verification couldn't run".** A `ModuleNotFoundError`/`ImportError` (even inside a Traceback) is the latter — an environment probe, not a logic failure. Don't file those as `severity: high` failures; they downgrade only when the run *also* failed to reach success.

## Conventions the implementer will hold your suggestion to

If you propose a fix direction, know the house rules (full set in `CLAUDE.md`):
- Errors surface to the user via Toast (`useToast().show('error', ...)`) — never swallowed.
- Renderer zustand stores never cross-subscribe; composition happens in components.
- All fs paths go through `validatePath`; atomic writes via `config.cjs` helpers.
- Max 3 concurrent `claude -p` jobs on this machine — don't propose designs that fan out wider.
- No backwards-compat shims; rename and refactor cleanly.
