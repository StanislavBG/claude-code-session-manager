# Validation: continue in a fresh session

Base: 576f358d22a43bf3f10866f995ece0a2acdf9bce. Commits: 4f8aec9d, fc3b7f69, ba70a3a4, fdc1f93e, 9cbba91a.
PRD files found in prds-archived/ (3436–3440).

Gate re-run (all PRD gates combined): `npx vitest run` over epicHandoff, epicIntake, launchSession, continueEpicFresh, promptSessions, EpicQueueRowMenu, EpicDetail tests → 7 files, 251 tests passed. `npm run typecheck` exit 0. `npm run lint` exit 0 (ends at lint:readme OK).

## epic-handoff-builder — VERIFIED
- summarizePrdOutcomes: last event with a validation wins; unvalidated only when outcome 'completed' — epicHandoff.ts:40-58.
- buildEpicHandoff: header "Continued from session <id> — <title>", "Where it stopped" with 4000-char cut + note, "No earlier answer was found.", counts + refuted/unvalidated slugs capped at 20, closing line — epicHandoff.ts:82-116.
- 6000 cap, never throws on malformed input (defensive coercion throughout) — epicHandoff.ts:112-115.
- Tests present: src/renderer/lib/__tests__/epicHandoff.test.ts (112 lines), passing.

## epic-intake-handoff-part — VERIFIED
- `handoff` field and AimPart 'handoff' → Input slot — epicIntake.ts (EpicIntakeFields, PART_SLOT).
- Section after injections, before references, label 'Handoff', source fromEpicId — epicIntake.ts:290-293.
- No handoff → nothing pushed; existing tests unchanged and pass.
- EpicIntakeCard PART_LABEL has Handoff (EpicIntakeCard.tsx:43). epic-primitives.tsx needed no change (typecheck green; no part switch there).
- Tests added in epicIntake.test.ts (+50).

## launch-session-carries-runtime-and-handoff — VERIFIED
- New optional fields on LaunchSessionInput — launchSession.ts:36-47.
- handoff → composeEpicIntake; model/packs/agentCli/agentCliModel in runtime; developLoop only when false — launchSession.ts:83,89-94.
- Calls without the new fields spread nothing; existing tests pass unchanged. +30 test lines.

## continue-epic-fresh-action — VERIFIED
- continueEpicFresh throws in words when the Epic is missing — continueEpicFresh.ts:31.
- Reads last assistant turn, failed read falls back to null (→ "No earlier answer"); outcomes from store events — continueEpicFresh.ts:17-28,42-47.
- launchSession gets same cwd, split title/goal, tag, agent, model, effort, packs, agentCli, agentCliModel, developLoop, source, handoff — continueEpicFresh.ts:49-62.
- Audit epic_continue emitted (continueEpicFresh.ts:64); kind in AUDIT_LOG_KIND (ipcSchemas.cjs:1180) and AuditEventKind (promptSessions.ts:440). fromEpicId added to the strict schema and passes through preload (index.cjs:465) and main handler (index.cjs:1137-1138) to the log.
- Tests: continueEpicFresh.test.ts (135 lines), passing.

## continue-fresh-menu-and-header — VERIFIED
- Row menu item right after 'Duplicate as new session', source 'EpicQueue row menu', selects new Epic, error toast — EpicQueue.tsx:344-353.
- Header button epic-continue-fresh for active/completed, source 'Epic header', disabled while running, opens new Epic, error toast — EpicDetail.tsx:1097-1120.
- contextLarge → AMBER tone, else plain — EpicDetail.tsx:1111-1113.
- Tests added in EpicQueueRowMenu.test.tsx and EpicDetail.test.tsx; passing.

## Code-reading checks requested
- New session created only via launchSession → usePromptSessions create → window.api.promptSessions.create, from a human press (menu onSelect / button onClick). No new creation path, no new MINT_AUTHORITY.
- Old Epic untouched: continueEpicFresh only reads store, transcript and events; no write to the source Epic.
- Opening prompt without handoff unchanged: composeEpicIntake pushes the section only when handoff text is non-blank; launchSession spreads handoff only when set.
- Visual check: the button and menu item were NOT checked by launching the app. A visual check by the owner is still due.

## Findings
Critical: none.
Important: none.
Minor:
- continueEpicFresh.ts:35 adds a throw when the Epic has no agentType (not in the PRD); harmless and clearly worded, but untested by the PRD's list.
- Review tools: /code-review and /security-review not run here; self-reviewed the diff (input flows through zod-validated IPC, no path building, no secrets, no existing helper duplicated).
