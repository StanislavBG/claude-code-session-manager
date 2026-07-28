---
name: issue-address:select:reject-fixed
description: Reject candidates from issue-address:select:fetch-pool's pool that are already fixed in current code, by checking the actual file/behavior each issue cites against a freshly-fetched origin/main — semantically, not just a literal string grep. Second sub-step of issue-address:select.
---

# issue-address:select:reject-fixed

The check that would have caught issue #180 before any other work started — its body
cited `apps/web/app/app.css` around specific line numbers, and the current code already
had the exact fix (`min-width: 0`) the issue was reporting the absence of.

## Steps

0. **Fetch fresh before checking anything.** `git fetch origin main` first, and read
   against `origin/main`, not a local branch — a local checkout can be stale or on an
   unrelated feature branch, and a stale read produces a false "still broken" verdict.
   (Found live: `#194` looked unfixed against a stale local branch, but `origin/main` had
   merged the fix days earlier.)

1. **For each candidate whose body cites a specific file, line, function, or CSS
   selector/rule**, read the actual current code at that location:
   ```bash
   git show origin/main:<cited-path> | sed -n '<start>,<end>p'
   ```
   or grep for the cited selector/function name if line numbers have drifted (files get
   reorganized — issue #180's citation was for `apps/web/app/app.css`, which had since
   been split into `apps/web/app/styles/*.css`; searching by class/function name across
   the styles directory found the real current location).

2. **Check the behavior semantically, not just for the literal string the issue used.** A
   fix can land in a different code *shape* than the issue's own words. (Found live: `#57`
   asked for a `<link rel="canonical">` tag; a literal grep for `rel="canonical"` found
   nothing, so the naive check would have called it unfixed — but the actual fix was a
   data-driven React Router `meta()` descriptor, `{ tagName: 'link', rel: 'canonical', href
   }`, which produces the same tag at render time without ever containing that literal
   string in source.) Before concluding "not fixed" on a bare grep miss:
   - Search one level broader — the surrounding directory/module, a shared
     helper/util file, a `meta.ts`/`config.ts`-style indirection layer — for the *behavior*
     the issue describes, not just its exact wording.
   - If the issue names a concrete symptom (a missing tag, a wrong computed value, a
     missing gate), look for whatever code *produces* that output, however it's
     structured, before deciding the symptom is still present.

3. **Compare what the issue describes as broken against what the code currently does.**
   If the issue's own hypothesized fix (or an equivalent one, per step 2) is already
   present — reject, log as `already-fixed`, cite the exact current file:line as evidence.
   Don't spend a full `issue-address:reproduce` pass confirming what a direct code read
   already answered.

4. **If the citation is vague, or the file has moved/renamed and a reasonably broadened
   search (step 2) still finds nothing**, don't reject on inconclusive evidence — mark the
   candidate `unconfirmed` and let it pass through to the next sub-step. This step only
   rejects on positive evidence of an existing fix, never on failure-to-locate.

5. **If the git history around that file shows the fix landed suspiciously close to the
   issue's `createdAt`** (within a day or two, either direction), note that explicitly —
   it's a strong signal the report and the fix crossed in flight (exactly what happened
   with #180: fix committed 2026-06-29, issue filed 2026-06-30).

## Output

Two lists: `already-fixed` (rejected, with evidence) and `survives` (candidates to pass to
`issue-address:select:reject-claimed` next, tagged `unconfirmed` where this step couldn't
conclusively check).
