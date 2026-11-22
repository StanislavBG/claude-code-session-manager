# Validation: fix wave — agent-model-evidence-from-parsed-lines (3485) + agent-resolved-model-id-is-concrete (3481, second check)

Base: 50dce25d. Fix commit: 0024b871 (touches exactly the 2 PRD files: effectiveModelInfo.cjs and its test). Both PRD files found in prds-archived/.

## agent-model-evidence-from-parsed-lines — VERIFIED
1. Header only from a line starting `[scheduler] agentType=` before the first `{` line: effectiveModelInfo.cjs `headerRe` (`^\[scheduler\] agentType=...`) and the loop that breaks at `startsWith('{')` (findLatestSchedulerModel). HOLDS.
2. Alias → `model` of first parsed `system`/`init` line; none → `continue` to next job: same function, `.find(o.type==='system' && o.subtype==='init')`. HOLDS.
3. Transcript: tail split into lines, parsed, `message.model` of last `assistant` line: findLatestTranscriptModel (`parseJsonLines`, reverse loop, `e.type !== 'assistant'`). HOLDS. (It takes the last assistant line whose id also fits; a non-fitting last line is skipped, consistent with criterion 4's "skip and go on".)
4. `MODEL_ID_SHAPE = /^claude-[a-z0-9.-]+(\[[a-z0-9]+\])?$/` applied in `fitsAlias` to every log and transcript id; family and session-override rules unchanged. HOLDS.
5. Concrete pinned persona: `isConcreteModelId(logged)` branch still echoes; unchanged resolve path. HOLDS.
6. Tests with the real shapes (quoted header/model in later JSON lines, quote-only head, transcript with later quoted model, `<synthetic>`) are in the test file (+86 lines in 0024b871); suite green. HOLDS.

Gate re-run: `vitest run effectiveModelInfo EffectiveRuntimeLine agentAdminRoutes externalContract` → 6 files, 85 tests passed; `npm run lint` exit 0; `npm run typecheck` exit 0.

## agent-resolved-model-id-is-concrete — VERIFIED (second check)
Criteria 1–6 held in the first record; the code paths are now stricter (id shape check added in `fitsAlias`). Refutation reason (malformed dev-lead id) is gone — see live run.

### Live read-only run (resolveEffectiveModelInfo, cwd /home/bilko/Projects/session-manager; newest dev-lead log includes this fix's own log)
| agentType | modelAlias | resolvedModelId | resolvedFrom |
| --- | --- | --- | --- |
| dev-lead | opus | `claude-opus-5-5` | scheduler-run |
| validator | sonnet | `claude-sonnet-5-5` | scheduler-run |
| architect | opus | `claude-opus-5-5` | transcript |
| bilko-ceo | fable | `null` | null |

All are null or well-formed ids of the persona's own family; none is an alias or of another family.

## Combined diff review
`git diff 50dce25d..HEAD` is only the two files above. Self-review (code-review/security skills not run as separate agents): no secrets, no path building from evidence text (log path comes from queue runId/slug as before), JSON.parse is try/caught, regexes are linear. No existing helper duplicated.

## Findings
### Critical
none
### Important
none
### Minor
Minor: none.
