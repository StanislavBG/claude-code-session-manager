# builder — Field Manual step

Runs as step 5 of `builder` when `session-manager-operations/manual/manual.json` exists, or on
its own ("update the manual", "does the manual need a revision"). Standalone, derive the commit
list and version the way step 1 does.

The manual is a **product we publish**, not generated documentation: it has its own version
line, and readers follow it step by step and are owed accuracy.

- **Source of truth:** `session-manager-operations/manual/` (its `README.md` has the on-disk
  shape and release checklist).
- **Build:** `npm run manual:build` → `~/Projects/Bilko/data/manual/releases/<version>/`.
- **Price:** free — every chapter and both downloads (root `CLAUDE.md`, open-core law). The
  legacy `session_manager` Stripe SKU stays wired only so late payments resolve; it sells nothing.

## 1. Decide whether a revision is owed

Read `manual.json`; compare `documentsAppVersion` with the version just published. Map the
release's commits onto the chapters: a chapter is **affected** when a commit touched a surface
it describes (grep the diff for the file paths, tab names, flags and CLI invocations the chapter
names).

| Finding | Action |
| --- | --- |
| No commit touches a documented surface | Bump `documentsAppVersion` only, report "no content change", stop. No manual release for a version bump alone. |
| A commit changes behaviour a chapter describes | Revise that chapter (step 2). |
| A commit ships a surface no chapter covers | Report it as a **gap** with a proposed chapter; don't author a whole chapter unprompted. |

## 2. Revise the affected chapters

Edit the chapter HTML in `session-manager-operations/manual/chapters/`.

- Follow `manual/STYLE.md` (voice, reading level, component vocabulary).
- Every claim must be checkable against real code now: read the file, run the command, confirm
  the constant. A wrong instruction breaks every reader who follows it.
- Never invent a screenshot. A figure with no captured image stays a `manual-figure__frame`
  placeholder saying what still needs capturing.
- Write an operator's guide — what a surface is for, the one thing people get wrong, the
  workflow that pays off — not a restatement of the codebase.
- Every chapter carries `free: true`; `web/manual/build.mjs` refuses a release where one lacks it.

## 3. Bump the manual's version

In `manual.json`: `documentsAppVersion` → the app version just published; `version` → patch for
corrections and figure fills, minor for a revised or added chapter, major for a restructure of
the chapter map (independent of the app's version); `releasedAt` → today in
America/Los_Angeles.

## 4. Build and verify

```bash
npm run manual:check     # sources valid, nothing written
npm run manual:build     # emits into ../Bilko/data/manual/releases/<version>/
ls ~/Projects/Bilko/data/manual/releases/<version>/
cd ~/Projects/Bilko && npx vitest run tests/manual.test.ts
```

The build is the gate: it refuses a missing chapter, a malformed or duplicated slug, an asset
without a source, or a chapter without `free: true`. A refusal is a stop. The Bilko test checks
every chapter and asset the manifest advertises exists on disk.

## 5. Commit both repos

The bundle is served from the Bilko repo, so an uncommitted bundle is an unpublished manual.
Commit locally once build and test pass: `session-manager` (chapter sources + `manual.json`)
and `~/Projects/Bilko` (`data/manual/releases/<version>/`). Pushing the Bilko side is what ships
it; treat that push with the same release trigger as the npm publish.

## Report

1. Manual version and `documentsAppVersion`, before → after.
2. Chapters revised, one line each: what changed and why.
3. Coverage gaps, as proposals.
4. Figures still pending capture, by chapter.
5. Whether the Bilko bundle is committed and pushed; if not pushed, say readers still see the
   previous edition.

Not in scope: screenshot capture, the product page in the Bilko repo, and pricing — the legacy
SKU and `MANUAL_PRODUCT_KEY` mapping in `Bilko:shared/manual-catalog.ts` stay wired; removing
either is an explicit decision.
