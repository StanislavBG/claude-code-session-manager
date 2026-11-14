# Validation: question-card-answers plan

Base: a53d5fc35e62fc0dac9801f88aedcc5fc64a058f. Seven commits (3fb6c309 … 717d7ac5), 19 files.
Gates re-run: the union of all 7 PRD vitest gates (14 files, 235 tests) passed. `npm run typecheck` exit 0. `npm run lint` exit 0. `npm run test:unit` passed in full: 1053 files, 10219 tests, 1 skipped. The stderr noise in the full run is expected-error tests (PageShell Orphan) and is not a failure.
/code-review and /security-review were not run as skills here; I self-reviewed the diff instead.

## question-card-scheduler-preamble-blocks — VERIFIED
- promptPreamble.ts adds the 'scheduler-turn' and 'auto-start-turn' blocks with the exact labels and anchors in the PRD.
- `MACHINE_TURN_BLOCK_KEYS` equals ['scheduler-turn','auto-start-turn'].
- chat-preamble-anchors.test.cjs, chatSchedulerTurnFold.test.ts and the unmodified chatTranscriptFeed.test.ts all pass.

## question-turns-from-transcript-feed — VERIFIED
- stopSignal.ts:59-84 holds `normalizeQuestions` and `parseStopSignalQuestions`.
- chat.ts applyTranscriptEvent creates the question turn, merges in both arrival orders (`findOpenQuestionTurn`, ref adoption), and builds the question turn from the normalized list in onNeedsInput.
- `origin` is stamped in dispatchSend (chat.ts:566).
- chatQuestionTurns.test.ts passes, as do chat.test.ts, chat.eviction.test.ts and stop-signal-anchor.

## question-reply-compose — VERIFIED
- questionReply.ts matches the format spec: header line, blank line, `N. q`, `Answer:`, the delegate line with em dash, ` My note:`, and throws on every specified case.
- questionReply.test.ts passes.

## question-card-state — VERIFIED
- questionCardState.ts: `isMachineUserTurn` and a single backward pass in `questionCardStates` give answered, superseded or open as specified.
- The tests cover scheduler check-ins and external-origin turns without the stop-signal block staying open.

## question-drafts-store — VERIFIED
- questionDrafts.ts and its test pass, and lint passes. `QuestionCard` reads the raw slice and defaults outside the selector (QuestionCard.tsx:64-67).

## question-card-ui — VERIFIED
- QuestionCard.tsx renders a row per question with a textarea (aria-label 'Answer to question N'), an Answer button (disabled only when the text is blank, line 194), 'You decide', Edit and Send answers.
- `trySend` is called from click and keydown handlers only, once per resolution. It sends `composeQuestionReply` output, never the question text.
- The only `disabled` in the file is the blank-text check (grep, line 194). `chatRunning` no longer gates any answer control; ChatTranscriptTurn.tsx keeps it for the Retry button only.
- 'sent' and 'queued' call markSubmitted. A refused send keeps the resolutions and shows 'Send answers'.
- Answered and superseded cards are read-only with the specified chips. Question text renders as plain React text; there is no dangerouslySetInnerHTML.
- QuestionCard.test.tsx, ChatTurnClamp.test.tsx and EpicDetail.test.tsx pass.

## question-card-timeline-wire — VERIFIED
- epicTimeline.ts computes `questionCardStates(turns)` once over the unfiltered turns and sets `questionCardState` on question items only.
- EpicDetail.tsx:1156 passes the prop to the timeline Turn.
- epicTimeline and EpicDetail tests pass.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - The delegate note is taken silently from the textarea text. The only hint is the button's title attribute (QuestionCard.tsx), so the behavior is hard to discover.
  - promptPreamble.ts: `MACHINE_TURN_BLOCK_KEYS` is declared `readonly string[]` plus `as const`, which is redundant but harmless.
  - The 'sent' state shows "Reply sent." until the parent flips the card to 'answered'. This matches the PRD notes.
