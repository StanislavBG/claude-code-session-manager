---
name: requesting-code-review
description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements
---

# Requesting Code Review

Dispatch the native `code-reviewer` subagent (via the Agent tool, `subagent_type: "code-reviewer"`) to catch issues before they cascade.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug

## How to Request

**1. Get git SHAs:**
```bash
BASE_SHA=$(git rev-parse HEAD~1)  # or origin/main
HEAD_SHA=$(git rev-parse HEAD)
```

**2. Dispatch code-reviewer subagent:**

Use the Agent tool with `subagent_type: "code-reviewer"`, filling the template at `code-reviewer.md`

**Placeholders:**
- `{WHAT_WAS_IMPLEMENTED}` - What you just built
- `{PLAN_OR_REQUIREMENTS}` - What it should do
- `{BASE_SHA}` - Starting commit
- `{HEAD_SHA}` - Ending commit
- `{DESCRIPTION}` - Brief summary

**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

## Example

```
[Just completed Task 2: Add verification function]

You: Let me request code review before proceeding.

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[Dispatch code-reviewer subagent via the Agent tool]
  WHAT_WAS_IMPLEMENTED: Verification and repair functions for conversation index
  PLAN_OR_REQUIREMENTS: Task 2 from docs/plans/deployment-plan.md
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661
  DESCRIPTION: Added verifyIndex() and repairIndex() with 4 issue types

[Subagent returns]:
  Strengths: Clean architecture, real tests
  Issues:
    Important: Missing progress indicators
    Minor: Magic number (100) for reporting interval
  Assessment: Ready to proceed

You: [Fix progress indicators]
[Continue to Task 3]
```

## Integration with /develop

This is the **default** reviewer at `/develop`'s Phase 2 done-gate (step 8) — but not the only
one. `/develop` routes to a matching specialist first when a PRD's surface calls for it
(`api-designer` for API-contract changes, `security-auditor` for auth/input/data, `refactorer`
for structural refactors, `perf-profiler` for hot-path changes, `dependency-auditor` for
dependency bumps) and only falls back to this generic reviewer for everything else or when no
specialist fits. Don't treat this skill as covering ground those specialists already own.

Since this project's actual unit of work is a scheduler PRD (not a live multi-task session), the
review point is per-PRD, at its own commit range — `BASE_SHA`/`HEAD_SHA` above are that PRD's
commit(s), not an arbitrary task boundary from a different workflow shape. Review:
- **After a PRD completes**, as part of `/develop`'s definition-of-done gate (step 8) — every
  major/risky PRD, before calling it done.
- **When a PRD comes back `needs_review`** — read the scheduler's auto-filed RCA first
  (`rcaFeedbackHook`'s `<date>-rca-<slug>-<runId>.md`), then use this review to confirm the fix
  if one gets queued.

## Red Flags

**Never:**
- Skip review because "it's simple"
- Ignore Critical issues
- Proceed with unfixed Important issues
- Argue with valid technical feedback

**If reviewer wrong:**
- Push back with technical reasoning
- Show code/tests that prove it works
- Request clarification

See template at: requesting-code-review/code-reviewer.md
