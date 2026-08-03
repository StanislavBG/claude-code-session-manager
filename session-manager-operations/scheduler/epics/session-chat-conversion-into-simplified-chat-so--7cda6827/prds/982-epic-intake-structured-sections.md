---
title: composeEpicIntake returns structured sections; Epic first turn renders as an AIM briefing card
cwd: /home/bilko/Projects/session-manager
estimateMinutes: 20
sourcePromptId: session-chat-conversion-into-simplified-chat-so--7cda6827
dependsOn: [chat-turn-three-zone-frame]
---
# Goal

src/renderer/lib/epicIntake.ts's composeEpicIntake builds openingPrompt by string-concatenating SIX known sections in a fixed order, then returns a single flat string — discarding structure it had in hand at compose time. The result is that the first and most important turn of every Epic renders in Chat as a ~2 KB prose blob with no way to know it is structured. Return the sections as data alongside the prompt, persist them on the PromptSession, and render the Epic's first turn as an AIM briefing card of labeled, individually collapsible sections.

# Acceptance criteria

- [ ] CORE: composeEpicIntake returns a third field `sections: Array<{ kind: 'actor' | 'injection' | 'input' | 'mission' | 'goal' | 'reference'; label: string; text: string; source?: string }>` alongside the existing goalText and openingPrompt.
- [ ] CORE (non-negotiable): openingPrompt stays BYTE-IDENTICAL to today's output for every input combination — it is what goes on the wire to the claude CLI. Add a test that composes with a fully-populated input and asserts the exact current string, so any future drift fails loudly. Check for existing composeEpicIntake tests first and extend them rather than adding a parallel file.
- [ ] CORE: sections are emitted in the same order composeEpicIntake already concatenates them: 1 actor (`You are acting as the "<name>" agent: <description>`), 2 injection (each enabled CONTEXT_INJECTIONS entry, in CONTEXT_INJECTIONS key order — not caller order), 3 input (inputSummary from summarizeGroundingBoard, single-lined), 4 mission (agentTagDef(tag).initialPromptTemplate), 5 goal (`Goal: <title>` plus the objective), 6 reference (one per referencePath).
- [ ] CORE: sections is persisted on the PromptSession alongside openingPrompt, written through the epics writer per the single-writer law.
- [ ] CORE: the Epic's first turn renders from `sections` as an AIM briefing card — six labeled, independently collapsible section cards inside the three-zone frame; actor and mission expanded by default; injection and input collapsed to a one-line summary with a count.
- [ ] CORE: do NOT regex-parse the flat openingPrompt back apart. The card renders from structured data only. A test must prove the renderer never falls back to prose parsing when sections are present.
- [ ] EDGE (load-bearing — epicIntake.ts is upstream of every Epic ever created): an EXISTING Epic persisted before this change has no `sections` field. It must still render its first turn, falling back to the flat openingPrompt as a single block. Test this explicitly with a fixture lacking the field.
- [ ] EDGE: every section input is independently optional — composeEpicIntake already omits absent lines. A caller that passes none of agentName/agentDescription/inputSummary/tag/contextInjections (e.g. EpicQueue.tsx's scripted 'build' Epic) produces a valid shorter sections array and a valid card, not an error.
- [ ] EDGE: the existing singleLine() defense against newline-forged structural lines in user/filesystem-controlled reference paths and titles must remain effective; confirm a crafted filename cannot forge a fake section boundary in either openingPrompt or sections.
- [ ] INTERACTION EFFECT: NewEpicCard.tsx's handleCreate computes the grounding board fresh at submit time when 'advanced' was never opened. Confirm sections is populated on BOTH paths (board already computed, and computed fresh at submit) and that no second fetch path is introduced — CLAUDE.md requires exactly one.
- [ ] INTERACTION EFFECT: goalText must not change — it is the Epic's displayed identity in the queue, Scheduler chips and composer header. Assert it byte-identical too.
- [ ] VALIDATION (must be shown, not asserted): screenshot a newly created Epic's first turn rendering as the AIM card, and an older Epic's first turn rendering via the flat fallback, in both Dark and Paper themes.
- [ ] `npm run typecheck`, `npm run test:unit`, and `node scripts/check-unstable-selectors.cjs` all pass.

# Implementation notes

Depends on chat-turn-three-zone-frame — read its landed diff first; the AIM card is a body renderer inside that frame, not a new frame.

Primary file: src/renderer/lib/epicIntake.ts. composeEpicIntake's current concatenation order, quoted so you do not have to re-derive it (build order is inside-out; EMITTED order is actor, injections, input, mission, goal, references):
  promptBody        = title ? `Goal: ${title}\n\n${goal}` : goal
  taggedPromptBody  = tag ? `${agentTagDef(tag).initialPromptTemplate}\n\n${promptBody}` : promptBody
  inputPromptBody   = inputSummary ? `${singleLine(inputSummary)}\n\n${taggedPromptBody}` : taggedPromptBody
  injectedPromptBody= injectedText ? `${injectedText}\n\n${inputPromptBody}` : inputPromptBody
  groundedPromptBody= agentName && agentDescription ? `You are acting as the "${singleLine(agentName)}" agent: ${singleLine(agentDescription)}\n\n${injectedPromptBody}` : injectedPromptBody
  return { goalText: withReferences(body, referencePaths), openingPrompt: withReferences(groundedPromptBody, referencePaths) }

The cleanest implementation builds the sections array FIRST and derives openingPrompt from it by joining with '\n\n', which makes byte-identity structurally guaranteed rather than merely tested — prefer that over maintaining two parallel code paths, but keep the byte-identity test either way.

Related files: src/renderer/lib/agentTagDefs.ts (agentTagDef(tag).initialPromptTemplate — never a drifted second copy of a tag's mission text), src/renderer/lib/contextInjections.ts (CONTEXT_INJECTIONS), src/renderer/lib/groundingBoard.ts (summarizeGroundingBoard / computeGroundingBoard), src/renderer/components/epics/NewEpicCard.tsx (handleCreate), src/renderer/state/promptSessions.ts (PromptSession shape and persistence).

Single-writer law (src/main/lib/opsOwnership.cjs, fail-closed): prompt-sessions is owned by the 'epics' writer. Any renderer-side write must declare that writer in the IPC payload, e.g. config.writeJson(path, data, 'epics').

Per CLAUDE.md, an Epic's title and objective are FIXED for the life of its session — this PRD changes only how the composed prompt is represented and displayed, never rewrites goalText after creation.

# Out of scope

- Changing what goes into the opening prompt — the AIM composition rules and their order are unchanged
- Making the grounding board a control rather than an inspector (session-manager cannot tell the claude CLI to skip a file it would discover on disk)
- Allowing a section to be edited after Epic creation — title/objective are fixed for the session's life
- Backfilling sections onto already-created Epics — the flat fallback covers them

## Engineering standards

Before writing any code, read `/home/bilko/.npm/_npx/5346543b21849140/node_modules/claude-code-session-manager/plugins/session-manager-dev/skills/develop/standards.md` — it has the Performance, Debugging,
API-reuse, TDD, and Execution-discipline rules that apply to this PRD. Every rule in it is
mandatory, especially Execution discipline (bounded commands, verify before done, the
finish-protocol sentinel).
