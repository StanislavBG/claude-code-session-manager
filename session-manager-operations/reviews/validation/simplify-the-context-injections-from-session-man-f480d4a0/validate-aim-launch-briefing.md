# Validation: AIM opening prompt + Launch briefing

Base: b16d1101 (known). Reviewer: validator. Gates re-run in the foreground in the job worktree.

Gate results: one combined `vitest run` over every gate file of PRDs 2644-2650 = 34 files / 505 tests passed; `npm run typecheck` exit 0; `lint:selectors` OK; `lint:hooks` OK; `lint:docs` ok; absence grep for epicStandingInstructions / buildEpicStandingInstructions / DELEGATE_IMPLEMENTATION_TEXT under src, scripts, tests, architecture = clean.

## aim-sections-normalizer — VERIFIED
- epicIntake.ts:93 AIM_SLOT_ORDER; toAimSections at :135, stable sort by slot at :146; AimSlot/AimPart/AimSection exports present.
- epicIntake.test.ts (incl. toAimSections cases) passes in the gate run.

## intake-section-part-schema — VERIFIED
- promptSessionSchema.cjs:66 `part: z.enum([...6 parts]).optional()`; kind enum left alone.
- promptSessionSchema.test.cjs passes; typecheck covers api.d.ts.

## aim-briefing-readers — VERIFIED
- EpicIntakeCard.tsx:59 `toAimSections(sections)`; inboundOpeningPrompt.ts:22; epic-primitives.tsx:187 `.find(s => s.part === 'goal')`.
- EpicIntakeCard, inboundOpeningPrompt, InboundProposalCard, EpicDetail tests pass; lint:selectors/hooks OK.

## compose-epic-intake-aim-slots — VERIFIED
- Commit 489a70fb; epicIntake.test.ts, launchSession, NewEpicCard, CustomerFeedbackInbox, EpicIntakeCard, contextInjections tests pass.

## cross-project-intake-aim-slots — VERIFIED
- Commit a7ba691f; crossProjectFeedback, Routes and feedbackTargetsWorktrees tests pass.

## remove-unwired-standing-instructions — VERIFIED
- Both files absent (ls: No such file); absence grep clean; src/main/lib/epic/ tests pass; typecheck 0.

## architect-persona-aim-order — VERIFIED
- architect.md diff: only item 6 wording ("reaches you in the Mission part of the opening prompt, after this persona") and seedVersion 4 -> 5 (one step); old phrase count = 0; body 4527 chars (< 6000).
- shippedPersonaSeeds.cjs: one new architect entry added, existing entries untouched; seedAgentPersonas.test.cjs passes.

## aim-briefing-docs — VERIFIED
- domain-model.md AIM bullet names three slots and parts in order, Persistence sub-bullet (kind = slot + part, 7 legacy kinds via toAimSections, never narrow kind enum), Actor source sub-bullet (resolveMergedPersona, body pasted since only subagents load it), "neither Actor nor Mission gets no grounding line"; lint:docs ok.
- Root CLAUDE.md: its only change in range is e038f102 (plain-sessions plan, other Epic); the AIM law line is untouched. CLAUDE.md is 11,987 chars (< 12,000).

## Findings

### Critical
- none

### Important
- none

### Minor
- src/main/lib/persona-macro/shippedPersonaSeeds.cjs (new architect entry): `commit: "2651bc05"` is the standing-instructions removal commit, not the persona commit (206cfd8e). Provenance-only field; no functional effect.
- CLAUDE.md is 13 chars under the 12,000 budget (other Epic's change); the next law line will need a split.
- Self-review (code-review/security-review not run as separate tools): no secrets, path handling or unsafe input found; toAimSections drops unknown kinds/parts without throwing; main schema keeps the kind enum wide so stored Epics still load.
