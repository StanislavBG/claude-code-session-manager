---
title: Add rich data-table rendering template for Claude responses in Chat Mode
source: GitHub issue gh-issue-2 (https://github.com/StanislavBG/claude-code-session-manager/issues/2)
type: enhancement
severity: normal
---

# What happens / what's missing

When Claude needs to return structured tabular data, there's no standard format to display it
richly in Chat Mode for Terminal. This results in loss of fidelity in data presentation,
inconsistent formatting of tabular information, difficulty reading/parsing structured data
responses, and Claude falling back to plain text or ASCII tables that don't render well.

**Use cases cited:** status reports (PRD tracking, job status, health checks), comparison data
(feature matrices, configuration comparisons, benchmarks), structured lists (file listings,
search results), analytics (token usage, performance metrics, cost breakdowns), schedules
(timeline views, dependency graphs).

# Evidence

GitHub issue #2: https://github.com/StanislavBG/claude-code-session-manager/issues/2

# Suggested direction (optional)

Per the issue's own proposal — a `data-table` template Claude can emit and the session-manager
renders as a rich, formatted table in Chat Mode. Two candidate syntaxes offered:

1. Markdown-like fenced block:
   ```
   :::table
   | Header 1 | Header 2 | Header 3 |
   |----------|----------|----------|
   | Value 1  | Value 2  | Value 3  |
   :::
   ```
2. JSON-based, for more control (headers, rows, column widths, sortable, highlightRow).

Rendering features requested: responsive column widths, per-column alignment, styling hints
(highlight rows, color-code status cells, monospace IDs), overflow handling (truncate/wrap),
terminal-friendly fallback to ASCII table in non-rich environments.

Implementation approach per the issue: document the template format in CLAUDE.md/skill docs so
Claude knows when to use it; session-output formatter detects table markup in Claude's response;
Terminal Chat Mode renders as a rich table (blessed/ink or similar); falls back to clean ASCII
table if rich rendering fails.

Acceptance criteria per the issue: Claude can emit structured table data using the defined
template syntax; session-manager detects and renders table markup in Chat Mode; tables respect
terminal width and wrap/truncate appropriately; basic styling (headers, alignment, borders) works
in terminal; fallback to plain/ASCII table if rich rendering unavailable; documentation added for
Claude to reference when generating tables.

## RESOLUTION

Ours, do it. Design decision made during triage: reuse standard GFM markdown table syntax (which
`marked`, already in use for Chat Mode rendering, parses natively) instead of inventing a custom
`:::table`/JSON format as the issue proposed — Claude already emits GFM tables without being
taught a new format. Queued as `543-chat-mode-data-table-rendering`, sequenced after
`542-chat-mode-markdown-formatting` (same file, `TerminalChat.tsx` — sequenced to avoid a
concurrent-edit conflict, a lesson from tonight's scheduler-concurrency incidents). Execution is
now the scheduler's job.
