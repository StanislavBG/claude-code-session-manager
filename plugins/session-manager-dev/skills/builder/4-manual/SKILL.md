---
name: builder:manual
description: Keep The Session Manager Field Manual — the paid $19.99 digital product sold at bilko.run/manual — in step with what actually shipped. Runs after builder:publish (or standalone), diffs the just-released commits against the manual's chapter map, revises the affected chapters, bumps the manual's own version, builds the release bundle into the Bilko repo, and reports what changed. Invoked as the last step of /builder, or directly via "/builder:manual", "update the manual", "does the manual need a revision".
---

# builder:manual (step 5)

The manual is a **product we sell**, not documentation we generate. It has its own version
line, its own release cadence, and a buyer who paid $19.99 and is owed accuracy. This step
exists so a shipped feature never silently invalidates a paid chapter.

- **Source of truth:** `session-manager-operations/manual/` (see its `README.md` for the
  on-disk shape and the release checklist).
- **Build:** `npm run manual:build` → `~/Projects/Bilko/data/manual/releases/<version>/`.
- **Sold via:** the already-live `session_manager` Stripe SKU. There is no second price to
  create; entitlement already exists for every past buyer.

## Inputs

The commit list from `builder:diff` (step 0) and the version `builder:publish` (step 3) just
shipped. When run standalone, derive both the same way step 0 does.

## Procedure

### 1. Decide whether a revision is owed

Read `session-manager-operations/manual/manual.json`. Compare its `documentsAppVersion`
against the version just published.

Then map the release's commits onto the chapter list. A chapter is **affected** when a commit
in the diff touched a surface that chapter describes — check the chapter body for the file
paths, tab names, flags, and CLI invocations it names, and grep the diff for those.

Three outcomes, and only one of them is work:

| Finding | Action |
| --- | --- |
| No commit touches any documented surface | Bump `documentsAppVersion` only, note "no content change", stop. Do **not** cut a manual release for a version bump alone. |
| A commit changes behaviour a chapter describes | Revise that chapter. Continue to step 2. |
| A commit ships a surface no chapter covers | Report it as a **gap** — propose the new chapter, but do not author a whole chapter unprompted; that's a scope decision for the human or an Epic. |

### 2. Revise the affected chapters

Edit the chapter HTML in `session-manager-operations/manual/chapters/`.

Hard rules — these are the ones that protect a paying customer:

- **Every claim must be checkable against real code right now.** Read the file, run the
  command, confirm the constant. A wrong instruction in a paid product is a refund.
- **Never invent a screenshot.** A figure slot that has no captured image stays a
  `manual-figure__frame` placeholder stating what still needs capturing. Placeholder text is
  honest; a fabricated UI is not.
- **Don't restate the codebase.** The manual is an operator's guide — what a surface is for,
  the one thing people get wrong, the workflow that pays off. If a paragraph would be equally
  at home in `CLAUDE.md`, cut it.
- **Preserve the free chapter.** At least one chapter must stay `free: true` — it is the
  marketing sample, and `scripts/build-manual.mjs` refuses to build without one.

### 3. Bump the manual's own version

In `manual.json`:

- `documentsAppVersion` → the app version just published, always.
- `version` → **patch** for corrections and figure fills, **minor** for a revised or added
  chapter, **major** for a restructure that changes the chapter map. This is independent of
  the app's version — a buyer tracks the manual's line, not the app's.
- `releasedAt` → today, in the user's local timezone (America/Los_Angeles).

### 4. Build and verify

```bash
npm run manual:check     # sources valid, nothing written
npm run manual:build     # emits into ../Bilko/data/manual/releases/<version>/
```

The build is the gate. It refuses on a missing chapter file, a malformed or duplicated slug,
an asset declared without a source, or no free chapter. A refusal is a stop, not a warning.

Then confirm the bundle is real — the manifest must not over-promise:

```bash
ls ~/Projects/Bilko/data/manual/releases/<version>/
cd ~/Projects/Bilko && npx vitest run tests/manual.test.ts
```

That test walks the shipped manifest and asserts every chapter and asset it advertises
actually exists on disk.

### 5. Commit both repos

The bundle is served from the Bilko repo on Render, so an uncommitted bundle is an
unpublished manual. Two commits, one logical release:

- `session-manager`: the chapter sources + `manual.json`.
- `~/Projects/Bilko`: `data/manual/releases/<version>/`.

Per the project's standing rule, commit locally as soon as the build and test pass — don't
wait to be asked. Pushing the Bilko side is what actually ships it to buyers, so treat that
push with the same release trigger the npm publish gets.

## Output

Report, in this order:

1. Manual version before → after, and `documentsAppVersion` before → after.
2. Chapters revised, one line each, saying what changed and why.
3. Coverage gaps found (shipped surfaces with no chapter) — as proposals, not as work done.
4. Figures still pending capture, by chapter.
5. Whether the Bilko-side bundle is committed and pushed. If it isn't pushed, say plainly
   that buyers are still seeing the previous edition.

## What this step is not

- Not a screenshot pipeline. Capturing and annotating real app screenshots is its own PRD;
  until it lands, figures are placed by hand and unplaced slots render as honest placeholders.
- Not a marketing-copy editor. The sales page (`SessionManagerPage.tsx` in the Bilko repo) is
  separate from the product it sells.
- Not a pricing or entitlement change. The $19.99 `session_manager` SKU and the
  `MANUAL_PRODUCT_KEY` mapping in `shared/manual-catalog.ts` are deliberately fixed — changing
  either strands existing buyers and needs an explicit decision, not a release step.
