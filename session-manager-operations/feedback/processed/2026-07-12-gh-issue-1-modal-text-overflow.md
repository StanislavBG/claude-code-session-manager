---
title: Modal text overflow causes horizontal scrolling - text should wrap within modal bounds
source: GitHub issue gh-issue-1 (https://github.com/StanislavBG/claude-code-session-manager/issues/1)
type: bug
severity: normal
---

# What happens / what's missing

Text content in modals is overflowing the container width, creating horizontal scrollbars. This
makes modal content difficult to read and breaks the UX flow, forcing users to scroll horizontally
to read full lines.

**Current behavior:**
- Long text lines in modals overflow their container
- Horizontal scrollbar appears at the bottom of the modal
- User must scroll horizontally to read full content
- Particularly affects code snippets, configuration examples, and long explanations

**Expected behavior:**
- All text content should wrap within the modal's visible width
- No horizontal scrolling required
- Content should be fully readable without additional scrolling actions
- The session-output formatter should handle text wrapping automatically

**Affected components** (per the reporter): modal dialog component, session output formatter, any
component rendering long-form text in modals (skill descriptions, error messages, configuration
displays).

# Evidence

GitHub issue #1: https://github.com/StanislavBG/claude-code-session-manager/issues/1
Reporter cites a screenshot of the modal displaying skill trigger analysis with long lines
extending beyond the modal width, requiring horizontal scrolling to read.

# Suggested direction (optional)

Per the issue's own proposal:
- CSS text wrapping: ensure modals have proper `word-wrap: break-word` or `overflow-wrap: anywhere`
  on text containers
- Max-width constraints: set explicit max-width on text elements within modals
- Pre-formatted text handling: for code blocks, use `white-space: pre-wrap` instead of `pre`;
  `overflow-x: auto` only for actual code blocks that need scrolling
- Session-output formatter enhancement: detect modal rendering context and apply appropriate
  wrapping rules

Acceptance criteria per the issue: text in modals wraps naturally without horizontal scroll; code
blocks can optionally scroll horizontally if needed, but prose text never does; modal remains
readable at various viewport widths.

## RESOLUTION

Ours, do it. Root-caused: `src/renderer/components/ui/Modal.tsx` has no
`overflow-wrap`/`word-break`/`white-space` CSS on its text-containing elements (confirmed via
grep — zero matches). Queued as `542-modal-text-overflow-wrap` (parallel group 542, independent
of the file the other two GitHub-issue PRDs touch). Execution is now the scheduler's job.
