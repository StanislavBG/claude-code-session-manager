# Validation: free hour link plan (PRDs 2638-2642)

Base: 8c7c7e9c8c8c17227a49cf51ca879712cfda408a. Commits: 7159e9da (readme), 067fee91 (helper), 3d0e73f1 (preload), 2a8848f5 (feedback panel), b5abee15 (help menu). PRD files found in prds-archived/.

## readme-free-hour-line — VERIFIED
- README.md:122 holds the exact line with utm_source=session-manager&utm_medium=readme; README.md:120 coffee line unchanged, appears once (grep -c = 1); blank lines either side.
- Commit 7159e9da: README.md 2 insertions, 0 deletions.
- Gate (both greps) exit 0. No `$`/per hour/pricing in the line.

## free-hour-link-helper — VERIFIED
- src/renderer/lib/freeHour.ts:9 FREE_HOUR_URL exact; desktop branch lines 29-35 (shell.open, toast on reject/ok:false); web branch lines 15-26 (window.open, opener nulled in try/catch, toast on null); header comment lines 1-5.
- freeHour.test.ts passes (with panel, preload and remoteApi tests: 5 files / 31 tests green). `npm run typecheck` exit 0; `npm run lint` green.
- See Minor 1 about the `$` literal.

## preload-on-open-free-hour — VERIFIED
- src/preload/index.cjs:53-57, api.d.ts:1853, apiSurface.json:177-182 (remote 'deny', after onRebootSession). apiSurface, preload-surface, remoteApi tests green; typecheck and lint green.

## feedback-panel-free-hour-link — VERIFIED
- CustomerFeedbackPanel.tsx:11 import; :180-190 paragraph after `</form>`, before `customer-feedback-list`, with specified testids, classes and onClick={openFreeHour}.
- New tests in CustomerFeedbackPanel.test.tsx (click, no-price) pass; gate green.

## help-menu-free-hour-item — VERIFIED
- src/main/index.cjs:1470-1481: last template entry `Help` > 'Book a Free Hour with Bilko', sends 'app:open-free-hour' via sendIfAlive behind the mainWindow guard; no accelerator/role/platform branch.
- src/renderer/App.tsx: import line 29; subscription at ~379-380 with the required comment; `offFreeHour()` in cleanup at ~482.
- application-menu.md: Today list names Help; click-item sentence extended; Help inventory row; '## Why a Help menu' section (3 sentences).
- Gate green (typecheck, lint, apiSurface/remoteApi/freeHour tests).

## No-price sweep
`git diff base..HEAD -U0 -- src README.md` added lines matching `$100|per hour|pricing`: only two test assertions (`not.toContain('per hour'|'pricing')`) in CustomerFeedbackPanel.test.tsx. No price wording in shipped text.

## Review of combined diff
The diff since Base also contains unrelated plain-session work (other plan); not reviewed here beyond the free-hour files. Self-review of free-hour changes: URLs are constants, only http(s) opens via the existing shell:open handler, web branch severs opener, remote policy 'deny' prevents fan-out of the menu click. No secrets, no path handling, no duplicated helper.

## Findings
- Critical: none.
- Important: none.
- Minor 1: src/renderer/lib/freeHour.ts:13 contains `${FREE_HOUR_URL}` in a template literal, so the PRD's literal "no '$'" criterion is technically unmet; it is template syntax, not price wording. Intent holds.
- Minor 2: application-menu.md '## Why a Help menu' quotes the Epic title; fine.
