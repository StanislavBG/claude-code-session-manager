// Epic thread — every conversation situation the Epic chat has to handle,
// and how the design answers each one inline. New sibling of epics-mock.jsx
// as of the 2026-08-01 design sync (claude.ai/design project
// 0ca33cd3-c2fa-4644-b728-bde42292abbd, variants/epic-thread.jsx) — the
// design's single `Turn` function split out into a router over 8 situations:
//
//   TAsk     — a question with named options, answerable by pick or by
//              prose (TReply: free-text answer embedded in the block).
//   TPerm    — a permission gate on a real command: Allow once / Always
//              allow <rule> / Deny.
//   TPlan    — a proposed plan you approve, edit inline, save as PRD, or
//              send back for re-planning.
//   TDiff    — a collapsible diff (+/- line counts in the header), with
//              Accept / Retry differently / Reject.
//   TError   — a failure with stderr shown, Fix and retry / Take it in
//              terminal / Skip this step.
//   TStream  — live streaming output with a blinking cursor and a Stop
//              button that keeps the partial turn instead of discarding it.
//   TNote    — a session-level divider (e.g. "context compacted"), not
//              anyone's message.
//   TSummary — what a completed turn cost/produced: stat chips + an
//              artifact (PRD) link.
//
// Every resolved decision (ask/perm/plan/diff/error) renders a TDone footer
// ("✓ label · note", with an Undo link) once acted on.
//
// TUser (the "your side" bubble) gained: a hover "Quote" button that seeds
// the Composer's reply-context strip, a "split into <epic>" affordance when
// a message spawned another Epic, and inline file/screenshot chips.
//
// THIS IS NOT YET MATCHED 1:1 IN CODE. The real app's Turn router
// (src/renderer/components/ChatTranscriptTurn.tsx) already renders real
// permission/diff/error/plan/tool-use situations against actual transcript
// events — it is the production analogue of this mock, driven by real data
// rather than illustrative fixtures, and is more mature in some respects
// (e.g. it already handles raw-session linking and inline file previews that
// this mock doesn't attempt). Treat a future diff pass as "does
// ChatTranscriptTurn cover every situation this mock illustrates", not as
// "port this mock's code" — the mock is a reference for INTENT, the real
// renderer is the implementation.
//
// Composer's quote-reply affordance (TUser's "Quote" button -> reply-context
// strip) is the one concrete gap identified in this sync that touches the
// composer rather than the Turn renderer — EpicComposer.tsx has no
// quote/onClearQuote today. Not filed as its own Epic yet; small enough to
// fold into a future composer pass.
