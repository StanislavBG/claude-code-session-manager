---
title: Typed renderers per event family — every transcript kind gets a designed card
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 28
sourcePromptId: session-chat-conversion-into-simplified-chat-so--7cda6827
dependsOn: [chat-feed-from-jsonl]
---
# Goal

With the JSONL feeding Chat, ~800 events per long Epic become reachable that previously had no UI at all. Rendering them as prose or raw JSON would be worse than hiding them. Give each event family a typed renderer in src/renderer/components/ChatTranscriptTurn.tsx, extending that file in place (its header explicitly says do not fork it). The governing rule, which must be stated as a code comment at the dispatch point: the classifier is a ROUTER, never a FILTER — every event reaches the UI; known kinds get a designed renderer, unknown kinds get a generic Signal card. A future Anthropic event type (e.g. a "TIP") must therefore appear automatically with zero code change; a code change only ever upgrades its presentation.

# Acceptance criteria

- [ ] Read src/renderer/components/ChatTranscriptTurn.tsx in full first and REUSE its existing exported primitives rather than adding parallel ones: TOOL_USE_TONE, TOOL_USE_ICON, collapseToolUseRuns, runLabel, ToolUseTraceStrip, CollapsibleToolStrip, DiffCard, UrlCallout, FileCallout, ERROR_TEXT, ERROR_TINT, AMBER_TEXT, AMBER_TINT. Also reuse renderChatMarkdown, computeLineDiff, formatAgo and MarkdownPreview.
- [ ] CORE: a single dispatch point maps event kind -> renderer, with an explicit `default` branch that renders the generic Signal card. Add a code comment at that default stating the router-never-filter rule and that it is the forward-compatibility guarantee for unknown/future event types.
- [ ] CORE (generic Signal card): renders the event's type name as a header plus a pretty-printed, syntax-highlighted JSON body, collapsed to 3 lines with an expand affordance. Add a unit test that feeds a completely made-up event type (e.g. { type: 'tip', ... }) and asserts it RENDERS rather than being dropped — this test is the executable statement of the forward-compat guarantee, do not omit it.
- [ ] CORE (conversation lane): assistant text via renderChatMarkdown; thinking blocks rendered INLINE IN ORDER with a distinct dimmed left-border tint (they are currently suppressed entirely); tool_use via the existing icon+label strip with runs collapsed via collapseToolUseRuns; tool_result as an outcome chip plus first line plus byte count, expanding to the full untruncated payload, reusing DiffCard where a diff applies; user prompts as markdown.
- [ ] CORE (signals lane, chronologically interleaved with the conversation — NOT a separate scroll container): mode and permissionMode render as an inline divider RULE, not a card (e.g. '— mode → plan —') because a state transition is a line; queue-operation as a chip with operation verb plus queued command text; attachment/deferred_tools_delta as a count chip ('+12 tools' / '−16 tools') expandable to the name list; attachment/mcp_instructions_delta as a named card with the server name in the header and a markdown body; attachment/skill_listing and attachment/agent_listing_delta as a count chip plus expandable name grid; attachment/task_reminder as a thin dim one-line strip; attachment/command_permissions tinted with the existing AMBER_TINT; attachment/edited_text_file reusing DiffCard directly; file-history-snapshot as a one-line restore-point marker.
- [ ] CORE (uncapped on inspect): expanding any card loads the FULL untruncated payload. Reuse the byte-reference/paging path the upstream PRDs added, and for Epic turn text reuse the existing durable per-Epic transcript (promptSessionTranscript.cjs) that appendResponseEvent already writes — do NOT invent a second full-text mechanism.
- [ ] CORE (show everything by default): no collapsed-by-default signal rail. Exactly TWO suppressions are permitted, both exact duplicates of something already displayed — repeated ai-title (show once as the session title) and last-prompt (duplicate of the immediately preceding user turn). Add a unit test asserting no OTHER kind is suppressed.
- [ ] EDGE: an attachment subtype not in the list above falls through to the generic Signal card rather than rendering blank.
- [ ] EDGE: an event with a null/empty/malformed payload renders its card shell with an explicit empty state rather than throwing and blanking the view.
- [ ] EDGE: a multi-MB tool_result renders its preview promptly and does not block the UI thread when expanded.
- [ ] INTERACTION EFFECT: this file is shared by TerminalChat (toolStripVariant='inline') and EpicDetail (toolStripVariant='collapsible'). Every new renderer must work in BOTH contexts — do not fork a parallel Turn variant. Grep importers before changing any exported signature.
- [ ] INTERACTION EFFECT: PRDs 845, 914, 915 and 916 already landed the per-turn caption layer, outcome label, and diff capture/rendering in this same file. Read their landed state and EXTEND it — do not rebuild captions, the outcome label, or DiffCard.
- [ ] VALIDATION (planned up front, must be shown not asserted): launch the app on a real Epic whose transcript contains attachment, mode and queue-operation events, and capture screenshots in BOTH the Dark and Paper themes proving each new renderer is visually distinguishable from plain prose. Any new color must be contrast-checked against all three paper background shades, following the discipline already used for ERROR_TEXT/AMBER_TEXT — do not introduce arbitrary Tailwind colors.
- [ ] Unit tests cover each named renderer family plus the unknown-type fallback.
- [ ] `npm run typecheck`, `npm run test:unit`, and `node scripts/check-unstable-selectors.cjs` all pass.

# Implementation notes

Depends on chat-feed-from-jsonl — read its landed diff first to confirm the event shape actually reaching the store.

Real event-kind frequencies measured across the last 20 sessions of this project, so you can size the work and build fixtures from reality: attachment 317 (subtypes: deferred_tools_delta 107, task_reminder 94, mcp_instructions_delta 77, agent_listing_delta 23, skill_listing 20, command_permissions 6, edited_text_file 3, queued_command 2), last-prompt 252, ai-title 217, queue-operation 122, mode 94, permissionMode 24, file-history-snapshot 5.

VERIFIED, do not chase: there are ZERO `*tip*` keys in any transcript under ~/.claude/projects/*/. Claude Code "TIPs" are rendered by the CLI into the terminal, not written to the JSONL. Do NOT build an ANSI/PTY scraper for them — the generic Signal card is the durable answer and will surface them automatically if Anthropic ever emits them as events. This is a deliberate scope decision, not an oversight.

Design intent reference only (do not port inline styles or raw hex): session-manager-operations/design-mocks/epics/.

CLAUDE.md constraints that apply: use Almanac design tokens; never return freshly-built values from zustand selectors (three prior blank-app incidents, guarded by scripts/check-unstable-selectors.cjs); surface non-fatal errors through useToast() rather than swallowing them.

# Out of scope

- The three-zone turn frame and per-message attribution chips (next PRD in the chain)
- The Epic grounding/AIM briefing card (later PRD in the chain)
- Any ANSI/PTY scraping to capture CLI-rendered TIPs — explicitly rejected above
- Changing what the classifier emits
- Adding a new nav tab or a parallel Simplified Chat surface — this reworks the existing Chat view

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
