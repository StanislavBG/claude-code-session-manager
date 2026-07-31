---
title: MCP Servers tab — show each server's purpose directly in the sidebar row
cwd: ~/Projects/session-manager
estimateMinutes: 20
---

# Goal

Implement the design already built and browser-verified in Claude Design (project "Session
Manager", file `List Detail - Guided.html` —
https://claude.ai/design/p/0ca33cd3-c2fa-4644-b728-bde42292abbd?file=List+Detail+-+Guided.html).

`src/renderer/components/tabs/McpServers.tsx`'s sidebar list (`ListDetail`'s `sidebar` prop,
lines ~271-311) shows each server's name, a connection-status dot, a status badge, and its
transport type (`stdio`/etc.) — but nothing about what the server actually *does*. A first-time
user sees a list of server names (`google-workspace`, `claude_design`, etc.) with no indication
of their purpose without opening each into `McpServerEditor`.

# Acceptance criteria

- [ ] Identify where a server's purpose/description could come from — `.mcp.json`'s per-server
  config shape doesn't have a standard `description` field today (check `McpServerConfig`'s type
  definition and the raw config schema before assuming). If no such field exists in the data
  model, add an optional one (e.g. a `description` string alongside `command`/`args`/`env` in the
  MCP server config type) that a user can set from `McpServerEditor`, defaulting to blank for
  existing entries — don't invent a description automatically for servers that don't declare one.
- [ ] In the sidebar row rendering (`McpServers.tsx:285-308`), show the server's description (if
  set) as a small, muted, single-line-clamped text under the name — matching the verified
  mockup's row layout (name + badges on one line, description below).
- [ ] Add a description field to `McpServerEditor`'s edit form so a user can set/change it for a
  given server (find that component and match its existing field-editing conventions rather than
  inventing a new form pattern).
- [ ] `timeout 300 npm run typecheck` passes.
- [ ] Add/extend a test (search `find src/renderer -iname '*mcpservers*spec*'` first) asserting a
  server with a description renders it in the row, one without renders name-only with no broken
  layout, and the editor round-trips a description edit correctly. Run via
  `timeout 120 npx vitest run <files touched>`.

# Implementation notes

- Read `src/renderer/components/tabs/McpServers.tsx` in full first, plus wherever
  `McpServerConfig`'s type and the `.mcp.json`/settings schema for MCP servers live (search for
  it — likely near `mcpStatus.cjs` or the settings JSON schema) before deciding whether a new
  field needs a schema change or just a renderer-side type extension.
- The verified mockup shows the exact row layout to match — connection-status dot, name, badges
  on the first line, description on the second.

# Out of scope

- Do not change connection-testing/probe logic (`deriveMcpConnectionState`, `probeContextUsage`-
  style status checks) — display only.
- Do not auto-populate descriptions for existing servers — leave blank until a user sets one.

## Engineering standards

Before writing any code, read `~/Projects/session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging, API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is mandatory, especially Execution discipline (bounded commands, verify before done, the finish-protocol sentinel).
