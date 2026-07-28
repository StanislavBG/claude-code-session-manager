---
name: issue-address:confirm-open
description: Step 1 of issue-address — confirm a named GitHub issue on the current project's repo is genuinely OPEN and not already claimed/fixed by another PR or duplicate issue, before any work starts. Returns a clear go/no-go.
---

# issue-address:confirm-open

Called with one issue number `<N>`. Produces a go/no-go verdict before any code work begins.

## Steps

1. **Fetch the issue.**
   ```bash
   gh issue view <N> --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --json state,title,body,comments,url
   ```
   If `state` is not `OPEN` — **stop, no-go.** Report the actual state (closed/merged
   reference) and why. Do not proceed to reproduce or fix a closed issue.

2. **Search for an existing open PR that already covers it** — check both explicit links
   and subject-matter overlap, since a PR can fix the bug without a formal `Closes #N`:
   ```bash
   gh pr list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --state open --search "<N> in:body"
   gh api search/issues -f q='repo:$(gh repo view --json nameWithOwner -q .nameWithOwner) is:pr is:open <N>'
   ```
   Also skim open PR titles for matching subject matter (same file area, same symptom).
   If found — **stop, no-go.** Report which PR number and why it looks like a match; don't
   duplicate work already in flight.

3. **Search for a duplicate open issue** covering the same underlying bug (different
   number, same root cause) — `gh issue list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --state open --search
   "<keywords>"`. If a duplicate exists and is a better-established report, flag it — the
   caller decides which one to actually work.

4. **Verdict.** Return one of:
   - **GO** — issue is open, unclaimed, no duplicate blocking it. Include the issue title,
     body, and any repro steps mentioned in comments, so the next step doesn't have to
     re-fetch them.
   - **NO-GO** — state why (closed / already covered by PR #X / duplicate of #Y), and stop
     the whole `issue-address` sequence here. Do not continue to reproduce/fix.
