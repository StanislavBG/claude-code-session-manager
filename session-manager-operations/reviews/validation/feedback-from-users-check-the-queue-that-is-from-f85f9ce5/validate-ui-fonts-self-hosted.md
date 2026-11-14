# Validation: ui-fonts-self-hosted + web-build-no-external-fonts

Base: a53d5fc3. Commits: 9665bc85 (ui-fonts-self-hosted), ef291d19 (web-build-no-external-fonts).

## ui-fonts-self-hosted (PRD 3096) — REFUTED (intent not met)

- Fonts dir: 16 files = 13 woff2 (Geist 300/400/500/600/700, Newsreader 400/500/600/700 + 400 italic, Plex Mono 400/500/600) + 3 OFL texts. `ls src/renderer/assets/fonts`.
- `src/renderer/fonts.css`: 13 `@font-face`, families Geist/Newsreader/IBM Plex Mono, woff2 only, `font-display: swap`; `body{font-feature-settings:'ss03' 1}` (end of file).
- `src/renderer/main.tsx:5-6` imports `./fonts.css` before `./styles.css`; `grep google|gstatic src/renderer/index.html` → none.
- Gate: typecheck exit 0, `npm run build` 0, `npm run build:web` 0. `dist-web/app.css` has `@font-face{font-family:Geist;…src:url(data:font/woff2;base64,…` and `body{font-feature-settings:"ss03" 1}`.
- **Criterion fails in effect (goal: "turn on Geist's alternate l so I and l differ")**: see probe below. With ss03 ON, `l` is a plain bar nearly identical to `I`; the tailed `l` is the DEFAULT (ss03 off). The set was not "confirmed from the font file" in the sense of visual outcome: the shipped setting removes the distinguishing tail.

## web-build-no-external-fonts (PRD 3097) — VERIFIED

- `src/renderer/web/index.html`: no googleapis/gstatic (grep clean).
- `remoteAssets.cjs` exports `externalStyleRefs` (link rel stylesheet|preconnect|preload hrefs + @import, http/https/`//`); `scripts/check-dist-web.cjs` prints each and exits 1 when non-empty.
- Tests `web-remote-assets.test.cjs`: 15 passed (Google link + preconnect returned; local app.css, inline style, local @import ignored).
- Gate: vitest file green; `npm run build:web` 0; `node scripts/check-dist-web.cjs` → "OK — every index.html reference is servable and same-origin" (exit 0).

## Real-path probe (headless Chromium, all non-file/data requests blocked, `--allow-file-access-from-files` needed because index.html uses `crossorigin` on file://)

- `document.fonts.check('16px Geist')` = **true**; body computed font-family `Geist, system-ui, sans-serif`, font-feature-settings `"ss03"`.
- DOM screenshots at 64 px, body font, ink bounding boxes (x0,y0,x1,y1 in a 100x100 cell):
  - `I`: [6,27,11,71] → 6x45
  - `l` (body ss03 ON): [6,27,10,71] → 5x45
  - `l` (feature-settings normal): [5,27,15,71] → 11x45 (tail)
- Pixel diff (top-left-aligned ink): I vs l(ss03) = **45 px** (equal height 45; differs only by 1 px of width: a bar vs a bar); l(ss03) vs l(normal) = 77 px; I vs l(normal) = 32 px.
- Verdict: I and l differ by width of one pixel, not in shape → probe criterion NOT met. Screenshot viewed: the ss03 `l` looks identical to `I`; the default `l` has a curved tail. Blocked request seen: `json.schemastore.org` (from the app's JS, unrelated to fonts).

## Full unit suite (SM_*/CLAUDECODE unset)

- Run 1: 2 files red: `procname-claude-spawn-sites.test.cjs` (killOrphanClaudePid → 'mismatch') and `check-ops-path-literals.test.cjs`. Run 2: only check-ops-path-literals red.
- procname-claude-spawn-sites: passes alone at HEAD and at Base → **load flake**.
- check-ops-path-literals "real repo tree is clean": fails alone at HEAD, passes at Base → **regression**, but from `src/main/lib/demo-video-kit/character.cjs:12` (`const OPS_ROOT_DIR = 'session-manager-operations'`, commit 79477880), not from these two PRDs.

## Findings

### Important
1. `src/renderer/fonts.css` (body rule at end): `font-feature-settings:'ss03' 1` turns the tailed `l` into a plain bar, making `I` and `l` look the same — the opposite of the goal. Fix: drop ss03 (default Geist l already has a tail) or confirm the right set visually; add a probe check that I/l differ in shape.
2. `src/main/lib/demo-video-kit/character.cjs:12`: ops-path literal breaks `check-ops-path-literals` (use `opsPath()` / allowlist). Unrelated to fonts plan; regression since Base.

### Minor
- `dist-web/index.html` `crossorigin` on app.css/app.js fails under file:// without `--allow-file-access-from-files` (expected for the web build; not a defect).
- `procname-claude-spawn-sites` is load-sensitive.
- Working-tree note: the two foreign `project-pages/*` files are unrelated.
