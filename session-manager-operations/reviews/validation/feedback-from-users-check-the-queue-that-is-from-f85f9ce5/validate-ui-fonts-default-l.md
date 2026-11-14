# Validation: ui-fonts-default-geist-l (PRD 3107) + remaining criteria of ui-fonts-self-hosted (PRD 3096)

Base: 43800306 (given). Commits since Base touching the PRD paths: `c70906c2 fix(fonts): drop Geist ss03 so lowercase l keeps its tail` (src/renderer/fonts.css, 6 deletions).

## ui-fonts-default-geist-l — VERIFIED
- fonts.css has no `font-feature-settings` / `ss03` (grep over the file returns nothing); 13 @font-face rules remain (`grep -c @font-face` = 13).
- Gate re-run: typecheck, `npm run build`, `npm run build:web`, `check-dist-web.cjs` all exit 0 ("check-dist-web: OK"). `dist-web/app.css` has no "ss03" (node check exit 0).
- Diff is limited to src/renderer/fonts.css.

## ui-fonts-self-hosted (3096) remaining criteria — VERIFIED
- `src/renderer/assets/fonts/`: 13 woff2 (Geist 300/400/500/600/700, Newsreader 400/500/600/700 + 400 italic, Plex Mono 400/500/600) and 3 OFL texts (geist, ibm-plex-mono, newsreader).
- fonts.css: 13 @font-face, woff2 only, `font-display: swap` on each (lines 9-106); families Geist/Newsreader/IBM Plex Mono.
- main.tsx:5-6 imports `./fonts.css` before `./styles.css`.
- index.html: no googleapis/gstatic reference (grep empty).
- dist-web/app.css contains 13 inlined `data:font/woff2` sources.
- Note: 3096's original "set ss03 on body" criterion is intentionally superseded by 3107 (ss03 made l identical to I).

## Real-path probe — PASS
Playwright Chromium, `dist-web/index.html` via file://, routing aborts every non-file/non-data request (needed `--allow-file-access-from-files` because the module script is `crossorigin` on file://; without it the app did not load, so body fell back to Times).
- Body font-family `Geist, system-ui, sans-serif`, font-feature-settings `normal`; `document.fonts.check('16px Geist')` = true; 6 font faces loaded.
- 64 px canvas ink boxes (threshold <128): 'l' = 11 x 45 px (286 ink px); 'I' = 6 x 45 px (270 ink px). Width difference 5 px (>= 4); ink-pixel difference 16.
- Blocked requests: 1, `https://json.schemastore.org/claude-code-settings.json` (an app runtime fetch, not a font).

## Full unit suite
`npx vitest run` with SM_* and CLAUDECODE unset: 1053 files passed, 1 failed (10254 tests passed, 1 failed). Red: `src/main/__tests__/supervisor-probe-stdin.test.cjs` (ENOENT on seen.json under load). Re-run alone at HEAD: pass; alone at Base (detached worktree 43800306): pass. Verdict: load flake, not a regression.

## Review
`/code-review` / `/security-review` not run separately; self-reviewed the 6-line CSS deletion: no input handling, secrets, paths or helper duplication involved.

## Findings
- Critical: none.
- Important: none.
- Minor: opening dist-web/index.html from file:// needs `--allow-file-access-from-files` (crossorigin module script); a validation-method note only, not a product defect.
- Minor: `supervisor-probe-stdin.test.cjs` is flaky under full-suite load (ENOENT reading seen.json).
