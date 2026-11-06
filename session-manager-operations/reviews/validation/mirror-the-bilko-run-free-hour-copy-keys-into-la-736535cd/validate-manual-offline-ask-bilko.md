# Validation: manual-offline-ask-bilko-note (PRD 2657)

Base: d73210494. Implementing commit: 45e8cf55 (touches exactly the 3 PRD files).

## Verdict: VERIFIED

Evidence per criterion:
1. askBilkoNote.mjs:24-32 — aside.manual-askbilko, escaped h2/p/link text, href `https://bilko.run`+href+`&utm_content=`+edition, escaped to `&amp;`.
2. askBilkoNote.mjs:22-27 — throws Error on href not starting `/book?utm_source=session-manager` and on edition not offline/pdf.
3. build.mjs:64-68 reads copy.json once via REPO-relative path, uses fail() when missing; build.mjs:154-172 composeOffline places note after chapter sections, before `<hr>`; line ~226 pdf uses composeOffline('pdf'). chapterHtml (per-chapter files) unchanged — note absent.
4. build.mjs OFFLINE_CSS: `.manual-askbilko` bordered box (2px solid); inside @media print `a.manual-askbilko__link::after{content:" (bilko.run/book)"}`.
5. `node web/manual/build.mjs --check` → "✓ manual v2.4.0 … (nothing written)", rc=0. Commit 45e8cf55 does not touch chapters (chapter change first-session.html is from unrelated commit a603bee8, a different plan).
6. Test file asserts decoded offline/pdf hrefs, escaping, both throws, no price; uses real copy.json.

Gate: `npx vitest run tests/unit/manual-askbilko-note.spec.ts` → 4/4 pass; `node web/manual/build.mjs --check` → rc 0.

## Findings
- Critical: none. Important: none.
- Minor: criterion 3's "per-chapter files lack the note" and the pdf composition are verified by reading, not by running a build (build writes to sibling repo; forbidden by PRD).
- Minor: no test covers the build.mjs integration (placement order); only the helper.
