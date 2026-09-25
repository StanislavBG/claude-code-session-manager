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
