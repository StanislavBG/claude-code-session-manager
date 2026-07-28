---
name: issue-address:select:fetch-pool
description: Fetch the FULL open-issue pool on the current project's repo with bodies, with verified completeness (not just a fixed --limit guess). First sub-step of issue-address:select.
---

# issue-address:select:fetch-pool

## Steps

1. **Fetch with a generous limit, then verify nothing was truncated** — don't trust a
   single fixed `--limit` the way an earlier version of this skill (and, separately,
   `pr-review-sweep`'s original GraphQL query) did; both silently truncated real data on
   this repo before. Converge instead of guessing:
   ```bash
   LIMIT=100
   while true; do
     COUNT=$(gh issue list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --state open --limit "$LIMIT" --json number --jq 'length')
     if [ "$COUNT" -lt "$LIMIT" ]; then break; fi   # got everything — count came in under the cap
     LIMIT=$((LIMIT * 2))                            # cap was hit exactly — double and re-check
   done
   gh issue list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --state open --limit "$LIMIT" \
     --json number,title,body,labels,assignees,comments,createdAt,reactionGroups
   ```
   `COUNT == LIMIT` is the tell that you hit the ceiling, not the true end of the list —
   never treat that as "done." Only stop once a fetch returns fewer results than it was
   capped at.

2. **Fetch bodies, not just titles.** Title-only scanning is what let issue #180 get
   picked without anyone reading its file/line citations first. `body` and `comments` are
   required output fields, not optional — the next sub-steps depend on them.

3. **Also fetch `reactionGroups`** (👍/👎 counts) — a real, if imperfect, community-signal
   input for `issue-address:select:rank-impact` later, beyond just label text.

## Output

The full, verified-complete list of open issues with bodies, labels, assignees, comments,
and reaction counts — handed to `issue-address:select:reject-fixed` next.
