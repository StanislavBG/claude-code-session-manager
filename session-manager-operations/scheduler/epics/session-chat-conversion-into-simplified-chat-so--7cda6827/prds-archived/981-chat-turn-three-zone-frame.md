---
title: Predefined three-zone turn frame with per-message attribution chips
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 22
sourcePromptId: session-chat-conversion-into-simplified-chat-so--7cda6827
dependsOn: [chat-typed-event-renderers]
---
# Goal

Give every turn kind one predefined frame instead of ad-hoc per-kind layout, so a transcript that now shows everything still reads as one system. Three zones, always present, empty zones collapsing to nothing: Header (role/kind badge, timestamp, attribution chips), Body (the typed renderer from the previous PRD), Footer (expand, show-raw, copy). The attribution chips are the visible payoff of the classifier fix — attributionSkill, attributionPlugin, attributionMcpServer/Tool, effort, gitBranch, isSidechain, isMeta, isApiErrorMessage and interruptedByShutdown are all already on disk today and were being discarded by makeRaw(). Also give the Epic event-chain kinds their own render so a routed question stops looking like ordinary assistant prose.

# Acceptance criteria

- [ ] CORE: one shared frame component wraps every turn kind — conversation turns, signal cards, and event-chain cards alike. Zones are always structurally present; an empty zone renders nothing (no stray padding or empty borders).
- [ ] CORE (header): role/kind badge, timestamp via the existing formatAgo helper, and attribution chips sourced from the top-level fields the classifier now preserves: attributionSkill, attributionPlugin, attributionMcpServer, attributionMcpTool, effort, gitBranch, isSidechain, isMeta, isApiErrorMessage, interruptedByShutdown. A chip renders only when its field is present.
- [ ] CORE (footer): expand, 'show raw', and copy. 'Show raw' displays the EXACT untruncated JSONL line for that event, read via the byte-reference/paging path from the upstream PRDs — not a re-serialized approximation of the parsed object. Add a test asserting byte-identical round-trip against a fixture line.
- [ ] CORE (event-chain kinds): prd_created renders as a PRD chip showing slug plus status; closed renders as a terminator rule; a `response` event authored by src/main/lib/rcaReport.cjs (a scheduler job's needs_review question routed back to the authoring Epic) renders tinted with the existing AMBER_TINT and visually marked as a QUESTION AIMED AT THE HUMAN. Today these are indistinguishable from ordinary assistant text, which is the specific failure this line fixes.
- [ ] EDGE: a turn with no attribution fields at all renders a clean header with just badge and timestamp — no empty chip row.
- [ ] EDGE: isApiErrorMessage and interruptedByShutdown render with the existing ERROR_TINT, since both mean the turn is incomplete; confirm they are visually distinct from a normal completed turn.
- [ ] EDGE: a very long gitBranch or MCP tool name truncates in the chip without breaking header layout.
- [ ] INTERACTION EFFECT: PRD 845 already landed the 'you · age' / 'claude · age' caption layer, the running dot, the 26px avatar and the bubble corner geometry in this same header region, and PRD 914 landed the outcome label it renders. Read their landed state and FOLD the new chips into that existing header — do not build a second caption row or duplicate the outcome label.
- [ ] INTERACTION EFFECT: the frame must work in both toolStripVariant='inline' (TerminalChat) and 'collapsible' (EpicDetail) contexts without forking a parallel Turn variant.
- [ ] VALIDATION (must be shown, not asserted): screenshot a real Epic turn carrying at least one attribution chip AND a real rcaReport-authored response event, in BOTH Dark and Paper themes, proving the routed question is now visually distinct from assistant prose.
- [ ] Unit tests cover: chip rendering per field presence/absence; empty-zone collapse; the byte-identical show-raw round-trip; the rcaReport response tinting.
- [ ] `npm run typecheck`, `npm run test:unit`, and `node scripts/check-unstable-selectors.cjs` all pass.

# Implementation notes

Depends on chat-typed-event-renderers — read its landed diff first; the frame wraps whatever dispatch point it established.

Primary file: src/renderer/components/ChatTranscriptTurn.tsx (extend in place, do not fork — its header comment says so explicitly). Existing header-region code to extend rather than replace lives around the `Turn` export (~line 369) and the outcome span (~line 554: `{turn.outcome && <span className="font-mono ...">{turn.outcome}</span>}`).

Event-chain source of truth: src/renderer/state/chat.ts's appendPrdCreatedEvent (kind 'prd_created', FK-linked via causedByEventId) and appendResponseEvent (kind 'response', RESPONSE_EVENT_PREVIEW_MAX = 2000 preview in active-index.json, full text durable in promptSessionTranscript.cjs). The rcaReport path is src/main/lib/rcaReport.cjs writing runs/<runId>/root-cause-<slug>.md, appended as a response event on the AUTHORING Epic by scheduler.cjs's notifyNeedsReview, resolved from the PRD's sourcePromptId.

appendResponseEvent's bounded-preview-plus-durable-full-text split is ALREADY the correct pattern for the expand path — reuse it, do not add a second full-text mechanism. State that in a code comment so a later author does not re-solve it.

Reuse existing tokens (ERROR_TEXT/ERROR_TINT/AMBER_TEXT/AMBER_TINT) and Almanac design tokens; contrast-check any new color against all three paper background shades.

# Out of scope

- The Epic grounding/AIM briefing card (next and final PRD in the chain)
- Rebuilding the caption/avatar/outcome layer from PRDs 845 and 914
- Adding accept/reject action buttons to any card — no backing workflow exists (same reasoning PRD 916 recorded for DiffCard)
- Changing classifier or feed behavior

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
