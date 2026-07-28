---
name: issue-address:select:reject-claimed
description: Reject candidates already covered by a PR (open, OR closed-but-superseded-by-a-merged-successor) or already claimed by an assignee/comment/supersede-note — with every text-search hit manually confirmed before being trusted. Third sub-step of issue-address:select.
---

# issue-address:select:reject-claimed

## Steps

1. **Search for a PR that might already cover each surviving candidate — open AND
   closed, not just open:**
   ```bash
   gh pr list --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --state all --search "<N> in:body"
   gh api search/issues -f q='repo:$(gh repo view --json nameWithOwner -q .nameWithOwner) is:pr <N>'
   ```
   Also skim PR titles for matching subject matter (same file area, same symptom) — a PR
   can fix an issue's bug without a formal `Closes #N` link. Searching only `state:open`
   misses the real case found live: `#194` had two closed (not merged) PRs, `#203`/`#215`,
   each superseded — but the actual fix landed in a *third*, later PR (`#251`) that neither
   text-search-by-issue-number pass would find unless the closed ones are read first and
   followed to what replaced them (step 3).

2. **Never trust a text-search hit without reading it.** This already produced a false
   positive once: searching `"180 in:body"` matched PR #239 ("add automated price-anomaly
   screen"), which had nothing to do with issue #180 — the digit string almost certainly
   matched a line number or unrelated number elsewhere in that PR's body. For every
   text-search hit:
   - Open the matched PR's actual title + description.
   - Confirm it genuinely addresses the same file area / same symptom the issue describes
     — not just that the issue number appears somewhere in the text.
   - If it's a false positive (number coincidence, unrelated context), **discard the match
     and keep the candidate as unclaimed** — don't reject on a search artifact.

3. **For every closed-but-not-merged PR found in step 1, read its closing comment before
   deciding the candidate survives.** A PR closed without merging is not automatically
   "unclaimed again" — read why it closed:
   ```bash
   gh pr view <PR#> --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)" --json state,mergedAt,closedAt,comments
   ```
   - If the closing comment says the work was split/replaced ("затварям... но не защото
     работата е отпаднала", "closing in favor of #N", "superseded by #N", "merged into
     #N"), **follow the chain to whatever PR(s) it names**, and check *their* merge state
     the same way. Keep following until you reach a terminal state (merged = reject as
     already-fixed; still open = reject as already-covered; abandoned with no successor =
     candidate survives).
   - This chain can be more than one hop deep (found live: `#194`'s PR `#203` was split
     into `#251`/`#252`/`#253`; a sibling PR `#215` was independently closed in favor of
     the same `#251`) — don't stop at the first successor if its own comments point
     further.

4. **Reject candidates already claimed by a person, or already noted as superseded in the
   issue's OWN comments** (not just a linked PR's). Check `assignees` (non-empty =
   explicit claim) and skim the issue's `comments` for:
   - Claim language: "работя по това", "assigned to me", "I'll pick this up".
   - Supersede/decompose language: "предлагам да се затвори в полза на", "closing in
     favor of", "split into #N / #M / #P", "superseded by". (Found live: `#154`'s own
     comment thread explicitly proposed closing it in favor of child issues `#156`/`#158`/
     `#163` — a signal that lives in the issue's comments, not in any PR search at all.)
   Reject on either signal — don't take work someone else already started or already
   restructured, even informally.

5. **Search for a duplicate open issue** describing the same underlying bug under a
   different number — `gh issue list --state open --search "<keywords>"`, same
   confirm-before-trusting rule as step 2 applies here too. If a better-established
   duplicate exists, flag it rather than silently picking one.

## Output

`survives` list (candidates cleared of PR/claim/supersede/duplicate overlap — including
resolved multi-hop PR chains — with any false-positive search hits explicitly noted as
discarded) handed to `issue-address:select:rank-impact`.
