# Validation — Claude config wave 5

Base: 576f358d22a43bf3f10866f995ece0a2acdf9bce; HEAD at validation fe73f671. PRDs read from `prds-archived/` (3428-3431); none missing. Commits: aadaa7b2 (3428), c18c10c3 (3429), 939c82b8 (3430), fe73f671 (3431). Other commits in range (2fbe2f23 history) belong to another plan.

Commands re-run (foreground, at HEAD): `npm run typecheck` exit 0; `npm run lint` exit 0; `npx vitest run src/renderer` → 358 files / 3413 tests passed, 0 failed; `npx playwright test -c tests/web-ui/playwright.config.ts claude-config-shots` → 1 passed, 11 PNGs in `test-results/claude-config/`.
Review tools: `/code-review` and `/security-review` not run as skills; self-reviewed the diff (renderer-only class/markup changes, no input handling, secrets, paths or new helpers duplicated).

## project-config-test-memory-assertion — VERIFIED
- `ProjectClaudeConfig.test.tsx:299` now asserts `mx-list-folder-count`; test passes in the full run.
- `grep -rn 'mx-nav-' src tests` → only `MemoryExplorer.nav.test.tsx:74` and `MemoryExplorer.shell.test.tsx:120`, both `[data-testid^="mx-nav-"]` toBeNull absence assertions (valid, not stale positives).
- Only the test file changed (no product code). Gate: typecheck, lint, vitest src/renderer all 0.

## doc-editor-document-column — VERIFIED
- `TiptapBody.tsx:~52` `LIST_CLASS='marker:text-accent marker:font-semibold'` applied to bulletList/orderedList; `PAGE_MAX` 720/760, `PAGE_PAD` `px-9 py-7` (=36/28) / `px-16 py-12` (=64/48); `DocumentEditorPane.tsx:209` passes `fullScreen`.
- `TiptapBody.layout.test.tsx` (+66) asserts column max-width inline/full and marker class; green. `styles.css` not needed (Tailwind marker utilities).
- home-claude-md.png / home-skills.png / home-agents.png: orange bullets and numbers, centred column.

## agents-select-and-switch-style — VERIFIED
- `AgentDetail.tsx` SELECT_CLASS `appearance-none bg-bg-hi border-line rounded` + own `text-fg-faint` chevron svg; `AgentLibrary.tsx` segmented pill (`bg-bg-hi border-line`, active `bg-bg shadow-sm`) inside the AGENTS FOLDER card; detail is content-sized so the detail column scrolls; editor `min-h-[480px]`. `AgentLibrary.test.tsx` (+38) covers pill switch and select classes; green.
- home-agents.png: styled selects with chevrons, pill. Editor status bar is below the 1040px fold in the shot (see Minor 1).

## config-card-path-wrap-and-tools-icon — VERIFIED
- `ConfigLayout.tsx:57` path span `break-all`, no `truncate`; `ConfigLayout.test.tsx` asserts. `McpServerDetail.tsx:560-562` `AlmanacIcon name="tool"` in `text-fg-faint`; test asserts `mcp-tools-empty-icon`.
- project-memory.png: path wraps over two lines in full. project-mcp.png: leading icon on "Tools appear after a check".

## Wave-4 findings N2-N4 vs shots
- N2 (list markers, column width) — FIXED: home-claude-md/home-skills/home-agents show orange markers and a centred ~720px column, matching renders 10, 13, 15.
- N3 (Agents selects / Personas|Tags) — FIXED for selects with chevrons and the pill (home-agents vs 15). Residual: editor status bar still not visible in the 1040px frame (Minor 1).
- N4 (MCP tools icon; memory path truncation) — FIXED: icon present (project-mcp vs 08); path wraps fully (project-memory vs 05).
- N1 (stale `mx-nav-all`) — fixed by 3428; N5 (files outside PRD lists) — no new out-of-list files in this wave.

## Findings

### Critical
- none

### Important
- none

### Minor (one per line)
1. `AgentDetail.tsx:254,462` — at 1592x1040 the agent editor extends past the frame so its status bar (Saved · words · Save) is not visible without scrolling the detail column (home-agents.png); render 15 shows it. The PRD asked it never be clipped at 1040; it scrolls rather than clips, but the first-view result differs from the design. Visual only.
2. Agents sample shows effort `inherit` / runs-on `Claude Code` / all nine tools vs design's `high` / `claude` / five tools — harness sample data, not a defect.
3. 3429's `# Files` lists `styles.css` and `DocumentEditorPane.test.tsx`/`TiptapBody.layout.test.tsx`; styles.css untouched (not needed). Informational.
4. `/code-review` and `/security-review` were self-reviewed, not run as skills.

### New findings (one per line)
- No new Critical or Important findings.
- Minor 1 (agent editor status bar below the fold at 1040px) is the only new visual finding.
