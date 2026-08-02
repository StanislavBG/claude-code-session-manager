---
title: Fix inconsistent text formatting and wrapping in Chat Mode - bullet points running together, uneven line breaks
source: GitHub issue gh-issue-3 (https://github.com/StanislavBG/claude-code-session-manager/issues/3)
type: bug
severity: normal
---

# What happens / what's missing

Claude's markdown output is rendering poorly in Chat Mode, resulting in hard-to-read text with
formatting issues:

- **Bullet points running together**: list items that should be on separate lines are
  concatenating, making it hard to distinguish individual points (example from the issue:
  `✓ Whether the prompt is clear enough to proceed ✓ Whether it's a quick inline task vs. a full
  PRD-worthy feature ✓ Your communication style preference for conciseness` rendered as one run-on
  line instead of three separate bullets).
- **Inconsistent wrapping**: some rows wrap too early (leaving whitespace), others spill over the
  container — jagged, hard-to-scan text (some lines break at ~60 chars, others at ~120).
- **Run-on sentences**: multi-sentence explanations that would benefit from list formatting
  render as dense blocks of text instead.

**Root causes hypothesized by the reporter**: markdown parsing may not preserve line breaks from
Claude's output; word-wrap logic doesn't account for bullets/indentation/inline formatting;
newlines may be collapsed/ignored; list syntax may not be recognized correctly.

# Evidence

GitHub issue #3: https://github.com/StanislavBG/claude-code-session-manager/issues/3
Reporter cites a skill-trigger-analysis screenshot showing structured content rendering as
run-on text instead of clean, separated points.

# Suggested direction (optional)

Per the issue's own proposal:

1. Improve markdown parser configuration — recognize list items (`-`, `*`, `✓`) on separate
   lines; preserve intentional line breaks (double newline = paragraph break, single newline in
   lists = new item); use a robust markdown library with proper terminal rendering.
2. Consistent text-wrapping algorithm — compute available width as
   `terminalWidth - leftPadding - indentLevel * indentSize`; apply wrapping consistently; never
   wrap mid-bullet; preserve code-block formatting.
3. Smart list formatting — detect bullet/numbered lists, indent nested lists correctly, hanging
   indent for wrapped list-item continuation lines.
4. Visual spacing — vertical spacing between list items, blank lines between sections.

Acceptance criteria per the issue: markdown lists render with each item on a separate line;
bullets/checkmarks properly spaced and aligned; consistent wrapping across all content types;
long lines wrap at a consistent column width respecting terminal size; wrapped list items keep
proper hanging indentation; paragraphs have clear visual separation; no horizontal scrolling for
standard prose; code blocks preserve formatting without affecting list rendering. Reporter also
requests testing across short/long/nested lists, mixed content, very long lines (200+ chars), and
terminal width variations (80/120/160 columns).

## RESOLUTION

Ours, do it. Root cause not yet confirmed at triage time — genuinely uncertain whether this is a
`marked` GFM-list-parsing config gap or a CSS whitespace/wrap issue on the rendered container (both
plausible, not mutually exclusive). Queued as `542-chat-mode-markdown-formatting` with an explicit
reproduce-before-fix requirement (construct the issue's own run-on-bullets example, run it through
the actual `marked.parse()` call, confirm which hypothesis holds) rather than guessing the root
cause during triage. Execution is now the scheduler's job.
