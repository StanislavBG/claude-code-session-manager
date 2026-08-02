---
title: Chat turn cards — fix near-invisible visual contrast against the page
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 15
sourcePromptId: psess-msaup10i-1
---
# Goal

Assistant/question/notice turn cards in src/renderer/components/ChatTranscriptTurn.tsx render on `bg-elev` (#efe6d3), which is only ~3% darker than the page background `bg` (#f6efe1) in tailwind.config — confirmed by reading both the component and the color tokens. The result: a multi-paragraph agent reply has no visually perceptible card boundary and reads as one continuous wall of text against the page, rather than a distinct bounded message (compared against the Epics design mock, which gives every turn a clearly bordered card). Fix the contrast so every turn reads as a clearly bounded message block, without changing the overall warm-paper Almanac palette identity.

# Acceptance criteria

- [ ] Read src/renderer/components/ChatTranscriptTurn.tsx in full (already read once this session — every card background in the assistant/question/notice/error branches currently mixes `bg-elev` with the existing tint colors) and tailwind.config's `bg`/`line`/`rule` token definitions before changing anything.
- [ ] Increase the visual separation between a turn's card and the page it sits on — acceptable approaches (pick the one that best fits the existing Almanac design system, don't invent a new one): darken/adjust the `bg.elev` token itself (check every OTHER consumer of `bg-elev` first via grep — a global token change must not break Settings/Scheduler/other surfaces that also use it), OR add a visible `border` (using the existing `line`/`rule` tokens) to the assistant-turn card specifically instead of a global token change, OR add a subtle box-shadow. State which approach was chosen and why in the PR/commit message.
- [ ] The fix applies consistently to all of: the generic assistant text bubble, the 'working'/'placeholder' bubbles, the question card, and the notice card in Turn() — not just one branch.
- [ ] Verify visually: launch the app (check this repo's `run` skill or README for the established dev-launch pattern) and take a screenshot of a real multi-turn Epic Discussion thread with the fix applied, confirming turns are now clearly bounded against the page in a way they visibly were not before (the PRD's own before/after comparison is the acceptance proof, not just 'looks right').
- [ ] `npm run typecheck` passes; no existing test in src/renderer/components/__tests__ or epics/__tests__ regresses (run the relevant suites).

# Implementation notes

tailwind.config's color tokens: bg.DEFAULT #f6efe1, bg.elev #efe6d3, bg.hi #fbf6ec, line #e0d3b8, rule #d9c9a8 (grep for the `colors:` block to find the exact file/line). ChatTranscriptTurn.tsx's relevant card classNames: the assistant bubble at (search for) `bg-elev px-3 py-2 text-sm text-fg-dim ${bubbleCorners}` and the `dangerouslySetInnerHTML` prose-chat card; the question/notice cards already tint with ERROR_TINT/AMBER_TINT on top of a border — verify those remain legible after any base-token change. Grep `bg-elev` and `bg-bg-elev` across src/renderer before touching the shared token to see every consumer (Settings, Scheduler panels, etc. likely also use it).

# Out of scope

- Wiring the outcome/landed label (separate PRD chat-turn-outcome-wiring)
- Diff/plan rendering (separate PRD chain chat-turn-diff-data-capture / chat-turn-diff-rendering)

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
