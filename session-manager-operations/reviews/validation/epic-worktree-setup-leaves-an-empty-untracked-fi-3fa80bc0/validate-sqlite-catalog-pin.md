# Validation: sqlite-catalog-entry-pins-mcp-v1 (PRD 2737)

Base 83dfb526; landed in e4946be9 (merge cbdfa1bb). PRD found in prds-archived/.

## sqlite-catalog-entry-pins-mcp-v1 — VERIFIED

- AC1: `git diff` shows catalog.ts sqlite entry args = `['--with','mcp<2','mcp-server-sqlite','--db-path','<path>']`; one-line diff, no other entry touched.
- AC2: mcpPlaceholders.test.ts adds test expecting `[{ token: '<path>', label: '--db-path <path>' }]` for the pinned args.
- AC3: McpPlaceholders.test.tsx asserts patch not called before fill, then once, via `claudeConfig.patch` (payload fileId claudeJson, keyPath ['mcpServers','sqlite']) with args `--with mcp<2 mcp-server-sqlite --db-path /tmp/x.db`. Library.tsx:106 confirms `window.api.claudeConfig.patch` is the real write path.
- AC4: 'installs a placeholder-free entry immediately' asserts one patch call and no mcp-placeholder-form.
- AC5/Gate: vitest on both files: 2 files, 13 tests passed; `npm run typecheck` exit 0.

## Findings

- Critical: none. Important: none.
- Minor: McpPlaceholders.test.tsx:24 keeps an unused `writeJson` mock (harmless, PRD said keep existing mocks).
- Code/security self-review: test-only plus a static catalog arg; no input handling or secrets involved.
