---
name: maintaining-md-network
description: >-
  Reviews, audits or drift-checks a project's CLAUDE.md and wider markdown
  network (CLAUDE.md, AGENTS.md, rules, skills, docs, READMEs, auto memory) so
  agents start from one short entry map and find each fact in exactly one
  place, with nothing stale. Use when the user asks to review, audit, clean up,
  restructure or drift-check a project's CLAUDE.md or docs, when the Review MD
  network macro runs, or says "/maintaining-md-network". Takes a Scope and a
  Mode (Full review or Drift check).
---

# maintaining-md-network

**Goal:** every agent that works on or with this project starts from one short entry map, follows links to a few owner docs, and finds each fact in exactly one place, with nothing stale.

## Inputs

- **Scope:** a folder, or the whole project (default).
- **Mode:** Full review or Drift check.

## Rule

Research and report in the first turn. Change no files until the human approves, then plan the work with `/develop`.

## References

Each is one level deep; none links another.

- [placement.md](placement.md): read when deciding where a kind of instruction belongs, or what moves into a skill, rule, hook or subagent.
- [audit.md](audit.md): read for steps 1-4 (census, audiences, links, truth check), the time box and the subagent brief.
- [plan.md](plan.md): read for the report contents, verdicts, records and runtime state, the `/develop` order and cross-repo routing.
- [drift-check.md](drift-check.md): read for Drift check mode, running the script and the review record.

The script is `<skill base dir>/scripts/drift-check.cjs`.

## Full review

Copy this checklist and tick it off:

```
Full review
- [ ] 1. Census of every instruction and doc file (audit.md)
- [ ] 2. Audiences and entry points (audit.md)
- [ ] 3. Links and consumers (audit.md)
- [ ] 4. Truth check against code and config (audit.md)
- [ ] 5. Report: proposed network, one-owner table, verdicts, placement, maintenance plan (plan.md, placement.md)
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
