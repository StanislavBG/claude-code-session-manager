---
name: issue-address:select:rank-impact
description: Rank surviving candidates by a composite impact signal (priority label + community reactions + cross-references + repro quality), not label text alone, and output exactly one issue number. Final sub-step of issue-address:select.
---

# issue-address:select:rank-impact

## Steps

1. **Score each surviving candidate on multiple signals, not just its `priority:` label**
   (a label-only heuristic silently mis-ranks an unlabeled-but-severe issue below a
   labeled-but-minor one):
   - **Priority label**: `high` > `medium` > `low` > none (weakest single signal alone).
   - **Category label**: `bug`/`security`/`data-quality` outrank `enhancement`/
     `discussion`/`docs` for this skill's purpose (fixing something broken, not building
     something new).
   - **Community reaction count** (from `fetch-pool`'s `reactionGroups`) — more 👍 reactions
     is a real signal of user-felt impact independent of whatever label was applied at
     triage time.
   - **Cross-references** — check `gh issue view <N> --json timelineItems` (or equivalent)
     for how many other issues/PRs reference this one; a heavily-cross-referenced issue is
     blocking or informing other work, raising its effective priority above its label.
   - **Repro quality** — concrete repro steps / cited file-line locations beat a vague
     report; cheaper to reproduce reliably, lower risk of another #180-style dead end.

2. **Combine into a ranked order** — no single signal should override all others (e.g.
   don't let one 👍 reaction alone outrank an explicit `priority: high` label; use
   priority + category as the primary sort, reaction count + cross-references as
   tie-breakers within a tier, repro quality as the final tie-breaker).

3. **Output exactly one issue number** — the top of the ranked list — with a one-line
   justification citing which signals won, plus the full ranked list (not just the
   winner) and the rejected list from the earlier two sub-steps, so the whole selection
   is auditable, not just its conclusion.

## Output

Hand off the single selected issue number to `issue-address:confirm-open`, which
re-verifies it fresh (state, PR/duplicate claims) immediately before work starts.
