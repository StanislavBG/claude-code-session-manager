# Validation: drift-check map docs + pipe output

Base: 222f982a. Commits: 68146f5d (2835), 5aec16cd (2836).

## drift-check-stdout-complete-through-pipe — VERIFIED
- main() sets process.exitCode = findings ? 1 : 0 after stdout.write (drift-check.cjs ~L399); UsageError path writes stderr, exitCode = 2, returns (~L392-394). No process.exit left.
- runDriftCheck returns { root, map, notes, findings, counts, checkedFiles } (drift-check.cjs ~L381). Probe shows keys in that order.
- Test 'report survives a shell pipe past 64 KiB' (md-network-drift-check.test.cjs, end of file): real `sh -c '... | cat'`, asserts stdout > 65536 and 1000 findings. Unfixed script (222f982a) through a pipe on Bilko yields exactly 65536 bytes, confirming the pipe cut it exposed; fixed gives full output.
- Test 'checkedFiles is the last key' present.
- Gate: `npx vitest run md-network-drift-check + dev-plugin-skillset` -> 2 files, 27 tests passed. Existing exit-code tests pass.

## drift-check-doc-map-lookup-follows-imports — VERIFIED
- --map row: search order CLAUDE.md, AGENTS.md, then directly imported .md files (drift-check.md L25).
- Maintainer-comment section: same order, comment goes in the map file itself (docs/map.md example), warning that CLAUDE.md-as-map holds CLAUDE.md plus imports to 70 lines (L185-L191).
- Same section: Claude Code strips block-level HTML comments, raw-text tools (Read, MCP, scripts) do not, so strip in the tool (last paragraph).
- Map detection rule: direct imports, one hop (L64). `grep -i "only the root"` finds nothing.
- Output section lists root, map, notes, findings, counts, checkedFiles and the "comes last" sentence.
- plugin.json version 0.3.6; marketplace.json plugin entry 0.3.6, top-level stays 0.1.0.
- Gate 2: drift-check.cjs --root . --file drift-check.md -> findings [], exit 0.

## Real-path probe (read-only on Bilko)
- `--root /home/bilko/Projects/Bilko --checks limits | node JSON.parse`: parsed fully, map = docs/map.md, 26,445 bytes (file == pipe).
- Note: the "about 92 KB" figure matches the all-checks run today (88,866 bytes, file == pipe, parses, 241 checkedFiles, 269 findings), not --checks limits (which is small because checkedFiles is last but findings are few). The >64 KiB pipe case was therefore exercised with all checks; the old script gives 65,536 there.
- Bilko untouched (its existing dirty files are not mine).

## Findings
- Critical: none.
- Important: none.
- Minor: the probe as specified (--checks limits) is under 64 KiB, so it alone does not exercise the pipe fix; the all-checks run and the unit test do.
- Minor: the pipe unit test uses --checks links (1000-line README would also raise no-contents-list); harmless.
- Review: self-review of the diff (no unsafe input handling, secrets, or path issues added; no helper duplicated).
