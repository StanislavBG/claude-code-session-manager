# Validation: agent-resolved-model-id-is-concrete (PRD 3481)

Base: 18f804d7. Landed commit: b48b596a (touches exactly the 3 PRD files). PRD file found in prds-archived/.

## Verdict: REFUTED — live dev-lead resolvedModelId is a malformed string, not a model id

### Criteria evidence
1. Alias never returned; log alias → first fitting `"model":"..."` in head; none → next job: effectiveModelInfo.cjs:238-270 (`fitsAlias`, `jsonRe`, `continue`). HOLDS.
2. Transcript search skips sessions with other model: effectiveModelInfo.cjs:274-285 (`!s.model || s.model === modelAlias`). HOLDS.
3. Family check, `[1m]` stripped: effectiveModelInfo.cjs:204-224. HOLDS.
4. Concrete pinned persona echoed; alias/source/effort fields untouched: effectiveModelInfo.cjs:~340-345. HOLDS.
5. Tests: effectiveModelInfo.test.cjs:344-405 (dev-lead, alias-only log, architect override ×2, family). HOLDS.
6. external-contract.md `modelId` row reworded (git show b48b596a). HOLDS.

### Gate (re-run)
- `vitest run effectiveModelInfo EffectiveRuntimeLine agentAdminRoutes externalContract`: 6 files, 79 tests passed.
- `npm run lint`: exit 0. `npm run typecheck`: exit 0.

### Live read-only run (cwd /home/bilko/Projects/session-manager)
| agentType | modelAlias | resolvedModelId | resolvedFrom |
| --- | --- | --- | --- |
| dev-lead | opus | `claude-opus-5\\n');\n` (MALFORMED) | scheduler-run |
| validator | sonnet | `claude-sonnet-5-5` | scheduler-run |
| architect | opus | `claude-opus-5-5` | transcript |

No result is an alias and none is of another family. Architect no longer reports the fable id. But the dev-lead value is not a real model id.

## Findings
### Critical
none
### Important
- effectiveModelInfo.cjs:~246 (`jsonRe = /"model":"([^"]+)"/g`) and `fitsAlias` (:~221): `isConcreteModelId` accepts any non-alias string, and the family check is only `includes('opus')`. A dev-lead run-log head that quotes source text (a job that printed code containing `"model":"claude-opus-5\n');\n`) yields the garbage id live. An outside app pinning it would break. Fix: require the id to match a shape such as `/^claude-[a-z0-9.-]+$/` (and the transcript/log paths alike), so the scan moves on to the next match/job.
### Minor
- Minor: none.
