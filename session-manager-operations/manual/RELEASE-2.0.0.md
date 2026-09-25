# Field Manual 2.0.0 — release tracking

## Bilko branch `manual-v2`

- **Commit:** `744452a028ce13bde559e33657aa5509176ab738` — "fix(manual): light-theme reader with
  readable contrast" (worktree `~/Projects/Bilko-manual-v2`, not pushed; mv2-50 merges + pushes
  after validation).
- **Files touched:** `src/pages/ManualPage.tsx`, `src/index.css` (the `.manual-*` block only).
- **What changed:** the live reader at `bilko.run/products/session-manager/manual` was styled
  for a dark theme (`text-neutral-100/200/300`, `#f5f5f5`, `#d4d4d4`, `bg-neutral-900/950`) on
  the site's light cream background, making the title, header, and chapter text nearly
  invisible. Both files now use the site's own light palette (the `warm-*`/`fire-*` tokens
  `SessionManagerPage.tsx` uses), and `.manual-prose` + the `.manual-*` component classes are
  styled to match `STYLE.md`'s component vocabulary for 2.0.0 chapters.

### Measured contrast ratios (WCAG relative luminance, computed with a Node script — formula
below)

Page background is `--color-warm-50` (`#fefdfb`); card/box background is `#ffffff`. AA text
threshold is 4.5:1 for normal-size text.

| Role | Color | vs `#fefdfb` | vs `#ffffff` |
| --- | --- | --- | --- |
| Heading (`h1`/`h2`/`h3`, `warm-900`) | `#2d2520` | 14.79:1 | 15.03:1 |
| Body text (`.manual-prose`, `warm-700`) | `#6b5a49` | 6.49:1 | 6.60:1 |
| Lede (`warm-800`) | `#4a3d33` | 10.30:1 | 10.47:1 |
| Link (`fire-700`) | `#c04808` | 4.95:1 | 5.03:1 |
| Link hover / callout badge bg (`fire-800`) | `#993a0a` | 6.97:1 | 7.08:1 |
| Accent — tip (`emerald-700`) | `#047857` | 5.39:1 | 5.48:1 |
| Accent — analogy (`teal-700`) | `#0f766e` | 5.38:1 | 5.47:1 |
| Accent — note (`sky-700`) | `#0369a1` | 5.84:1 | 5.93:1 |
| Error text (`red-600`) | `#dc2626` | 4.75:1 | 4.83:1 |

Body text (`warm-700`, `#6b5a49`) against the aside tint backgrounds:

| Aside background | Contrast |
| --- | --- |
| `.manual-analogy` (`teal-50` `#f0fdfa`) | 6.32:1 |
| `.manual-tip` (`emerald-50` `#ecfdf5`) | 6.26:1 |
| `.manual-note` (`sky-50` `#f0f9ff`) | 6.19:1 |
| `.manual-warning` (`fire-50` `#fff7f0`) | 6.22:1 |

All pairs above clear the 4.5:1 AA threshold; the heading/body pair the PRD's acceptance
criteria call out (`warm-900`/`warm-700` vs `warm-50`) clears it by a wide margin (14.79:1 and
6.49:1).

The contrast formula used (standard WCAG relative luminance):

```js
function lum(hex) {
  hex = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const f = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [rl, gl, bl] = [f(r), f(g), f(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}
function contrast(a, b) {
  const [la, lb] = [lum(a), lum(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
```

### Verification

- `cd ~/Projects/Bilko-manual-v2 && npm run typecheck` — passed (exit 0).
- `.manual-incident` removed; `.manual-figure:has(.manual-figure__frame) { display: none; }`
  kept, restyled for the light background.
- `.manual-flow` stacks vertically (`flex-direction: column`) below 640px, per the STYLE.md
  box-and-arrow diagram component.

### Not in this pass

- Grouping the chapter list by part (`mv2-32` owns `shared/manual-catalog.ts`'s part field).
- Pushing `manual-v2` to origin (`mv2-50` merges and pushes after validation).

## mv2-32 — reader parts nav

- **Commit:** `10570bc` — "feat(manual): group reader chapter list by part" (worktree
  `~/Projects/Bilko-manual-v2`, not pushed).
- **Files touched:** `shared/manual-catalog.ts`, `src/pages/ManualPage.tsx`,
  `tests/manual.test.ts`.
- **What changed:** `ManualChapter` gains optional `part?: string`; `tocFromManifest` carries it
  through into the public `/api/manual/toc` response only when present. The reader's desktop nav
  now renders a small heading above the first chapter of each part (numbering continues across
  parts, unaffected), and the mobile `<select>` groups chapters with `<optgroup label={part}>`.
  Chapters without a `part` render exactly as before.
- **Verification:** `cd ~/Projects/Bilko-manual-v2 && npm run typecheck` — passed;
  `npx vitest run tests/manual.test.ts` — 10/10 passed, including the new part-passthrough
  assertion.

## mv2-40 — release bundle build

- **Commit:** `034f46c` — "manual: Field Manual 2.0.0 release bundle" (worktree
  `~/Projects/Bilko-manual-v2`, not pushed; mv2-50 merges + pushes after validation).
- **Files touched:** `data/manual/releases/2.0.0/` (13 chapter files, `manifest.json`,
  `field-manual-2.0.0.html`, `field-manual-2.0.0.pdf`, `figures/`).
- **What changed:** built the 2.0.0 release from `session-manager-operations/manual/`
  (`releasedAt: 2026-09-25`, `documentsAppVersion: 0.97.0`, both already current — no source edit
  needed) via `node web/manual/build.mjs --out ~/Projects/Bilko-manual-v2/data/manual/releases`.
- **Verification:** `npm run manual:readability` — exit 0, all 13 chapters 900–1,600 words;
  `timeout 120 npx vitest run web/manual/__tests__` — 14/14 passed; `cd ~/Projects/Bilko-manual-v2
  && timeout 300 npx vitest run tests/manual.test.ts` — 14/14 passed.

## mv2-50 — shipped live

- Precondition: `session-manager-operations/reviews/validation/the-manual-needs-to-be-redone-delete-and-start-o-3ba80794/validate-manual-v2.md`
  — all 19 PRDs VERIFIED, no Critical/Important findings (one Minor doc-count discrepancy, not a
  code defect), `SCHEDULER_VERDICT: PASS`.
- Merge: `~/Projects/Bilko` on `main` — `git fetch origin` (already up to date, 0 ahead/0 behind),
  `git merge --ff-only origin/main` (no-op), then `git merge --no-edit manual-v2` — clean merge,
  no conflicts with the repo's pre-existing shared-dirty foreign WIP (`public/outdoor-hours/*`,
  `session-manager-operations/*`), commit `94635fd` "Merge branch 'manual-v2'".
- **Push SHA:** `94635fd` (`e0241d8..94635fd  main -> main`).
- Deploy: polled `https://bilko.run/api/manual/toc` every 30s; version flipped from `1.10.1` to
  `2.0.0` at 23:19:46 UTC, ~1.5 minutes after push.
- Live verification (headless Playwright chromium via MCP, signed-out session,
  `https://bilko.run/products/session-manager/manual`):
  - Welcome chapter rendered with h1 contrast 13.73:1 and body-text contrast 9.56:1 against the
    page background (`#2d2520`/`#4a3d33` on `#f9f4ec`) — both clear the 4.5:1 AA threshold.
  - `#meet-your-agency` shows the locked state: "This chapter is part of the paid manual. Unlock
    all 13 chapters for $19.99." with a "Sign in to unlock" button.
  - Screenshots: `session-manager-operations/manual/RELEASE-2.0.0-live/welcome-chapter-signed-out.png`,
    `session-manager-operations/manual/RELEASE-2.0.0-live/meet-your-agency-locked.png`.
- Cleanup: `git -C ~/Projects/Bilko worktree remove --force ~/Projects/Bilko-manual-v2` (only
  untracked `node_modules` present) and `git -C ~/Projects/Bilko branch -d manual-v2` — both
  removed.
- Gate: `timeout 60 curl -fsS https://bilko.run/api/manual/toc | grep -q 2.0.0` — pass.
