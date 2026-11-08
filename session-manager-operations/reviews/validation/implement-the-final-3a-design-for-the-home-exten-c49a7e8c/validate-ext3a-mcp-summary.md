# Validation: ext3a-mcp-summary-matches-tab (PRD 2881)

Base f03d1e49; one commit: 5c09b665 (McpServers.tsx + McpServers.test.ts).

## ext3a-mcp-summary-matches-tab — VERIFIED

- AC1 summary = `<n> server(s)` (n = names.length), ` · <p> from plugins` only if p>0, ` · <m> checked`: McpServers.tsx:340-343, 406.
- AC2 no plugins → '<n> server(s) · <m> checked': pluralisation on names.length only (:341); the plugin part is conditional (:343).
- AC3 project scope: pluginServers forced to [] when scope !== 'user' (McpServers.tsx:265-267), so no ' · from plugins'.
- AC4 tests: McpServers.test.ts new case '4 servers · 1 from plugins · 0 checked' → '… · 5 checked' (diff); older assertions updated to '4 servers · 2 from plugins · …'.
- Gate: vitest McpServers + Extensions → 44 passed; typecheck clean; lint clean (lint:selectors/hooks included).

## Plan-level checks

- Playwright `extensions-shots.spec.ts`: 1 passed. mcp-light.png toolbar reads "7 servers · 1 from plugins · 1 checked", tab reads 7 (screens/mcp-light.png, mcp-dark.png).
- `npm run test:unit`: 965 files, 9285 passed, 1 skipped. `npm run typecheck`, `npm run lint`: green.
- Combined diff reviewed by hand (8-line source change, no input handling/secrets/paths).

## Findings

| Severity | Finding |
| --- | --- |
| Critical | none |
| Important | none |
| Minor | McpServers.tsx:343 filter does not affect the summary count (counts all plugin servers, not listed) — consistent with names.length, intentional. |
| Minor | Working tree shows foreign deletions of project-pages/home.html and demo-video/index.html (not this job's; not staged). |
