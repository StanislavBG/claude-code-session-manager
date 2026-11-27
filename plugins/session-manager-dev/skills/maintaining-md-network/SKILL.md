---
name: maintaining-md-network
description: >-
  Reviews, audits or drift-checks a project's CLAUDE.md and wider markdown
  network (CLAUDE.md, AGENTS.md, rules, skills, docs, READMEs, auto memory) so
  agents start from one short entry map and find each fact in exactly one
  place, with nothing stale. Use when the user asks to review, audit, clean up,
  restructure or drift-check a project's CLAUDE.md or docs, when the Review MD
  network macro runs, or says "/maintaining-md-network". Takes a Scope and a
  Mode (Full review, Drift check or Weekly consolidation).
---

# maintaining-md-network

**Goal:** every agent that works on or with this project starts from one short entry map, follows links to a few topic docs, and finds each fact in exactly one place, with nothing stale.

## Inputs

- **Scope:** a folder, or the whole project (default).
- **Mode:** Full review, Drift check or Weekly consolidation.

## Rule

Research and report in the first turn. Change no files until the human approves, then plan the work with `/develop`.

## What counts as a link

A doc reference in the map, an owner pointer or any doc is a link when it is one of:
- a markdown link [text](path);
- a backticked repo-root path to an existing `.md` file;
- an @path.md import.

All three count for reachability in Project Home's link map and in drift-check's orphans check. Prefer markdown links where humans read the doc rendered.

## References

Each is one level deep; none links another, except audit.md's census step, which links placement.md's pair rule.

- [placement.md](placement.md): read when deciding where a kind of instruction belongs, or what moves into a skill, rule, hook or subagent.
- [audit.md](audit.md): read for steps 1-4 (census, audiences, links, truth check), the time box and the subagent brief.
- [plan.md](plan.md): read for the report contents, verdicts, history and runtime state, the `/develop` order and cross-repo routing.
- [drift-check.md](drift-check.md): read for Drift check mode, running the script and the review record.
- [weekly-consolidation.md](weekly-consolidation.md): read for Weekly consolidation mode: inputs, change kinds, caps, the record and apply.
- [migrate-to-agents-md.md](migrate-to-agents-md.md): read when moving a project's CLAUDE.md text into AGENTS.md.

The script is `<skill base dir>/scripts/drift-check.cjs`.

## Full review

Copy this checklist and tick it off:

```
Full review
- [ ] 1. Census of every instruction and doc file (audit.md)
- [ ] 2. Audiences and entry points (audit.md)
- [ ] 3. Links and consumers (audit.md)
- [ ] 4. Truth check against code and config (audit.md)
- [ ] 5. Report: proposed network, one-home table, verdicts, placement, maintenance plan (plan.md, placement.md)
- [ ] 6. After approval, plan with /develop in the order plan.md gives; commit the review record (plan.md, drift-check.md)
- [ ] 7. Route cross-repo findings (plan.md)
```

## Drift check

Copy this checklist and tick it off:

```
Drift check
- [ ] Run the script over the changed files (drift-check.md)
- [ ] Re-do census, links and truth check only for files changed since the last review record (audit.md steps 1, 3, 4)
- [ ] Report findings; change no files until approved
- [ ] After approval, fix with /develop and write a new review record (drift-check.md)
```

## Weekly consolidation

Copy this checklist and tick it off:

```
Weekly consolidation
- [ ] Look for a pending weekly Task record; walk it if found (weekly-consolidation.md)
- [ ] Else gather memory, network, transcripts, Lessons blocks, steering file
- [ ] Subagents find patterns; keep those seen in 2+ sessions
- [ ] Write the record: verify, organize, enrich changes plus housekeeping
- [ ] Owner accepts or rejects each change; apply only accepted ones, commit the record
```
