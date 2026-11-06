# Validation: demo-video length select + pacing plan

Base: 825375379fd640e396069a866376f06a85288289; HEAD 75700dce. Commits: 510fddc9 (gate), a43a8be5 (text), e2035dab (select), af10938d + 112ed9ef (fixtures), 58d597dd (macro v5), 75700dce (persona v7).
Combined gate run (all 6 PRDs' vitest files): 10 files / 328 tests passed. `npm run typecheck`, `lint:selectors`, `lint:hooks` green. Full `npm run test:unit`: 877 files, 8289 passed, 1 skipped, 0 failed.

## demo-video-write-gate-60s — VERIFIED
- projectHomeAdminRoutes.cjs:74-75 MIN=5, MAX=60. Test file updated (61 row, 5/30/60 boundary); passes.
- project-pages/README.md:8 "30-second or 1-minute", :25 `5 <= N <= 60`.

## demo-video-tool-text-60s — VERIFIED
- scripts/scheduler-mcp-server.cjs:494 "demo video of 60 seconds or less", :498 `5 <= N <= 60`; no "30-second"/"<= 30".
- mcpToolCatalog.cjs:323 purpose "(30 seconds or 1 minute)", :328 "(5-60 seconds)".
- agentTagDefs.ts:56 "the overview page or the demo video". New tests in the two main test files pass.

## demo-video-length-select — VERIFIED
- ProjectPagesSection.tsx diff: DEMO_VIDEO_LENGTHS, `length` state at component top, lengthLine only when showStyle && '60', select testid project-home-demo-length / aria-label "Video length" right after style select, disabled={disabled}. Joins as style\nlength\nextra. 67 new test lines; gate, typecheck, lint green.

## demo-video-macro-v5-length — VERIFIED
- builtinMacros.cjs: builtinVersion 5; priorPrompts 4 entries, [3] = the v4 prompt (diff shows it moved verbatim); v5 prompt has 'Video length: 60', no "30-second". macroLibrary upgrade test and gate pass.

## demo-persona-shipped-fixture-tests — VERIFIED
- `cmp` of v5 fixture vs `git show 65585305^:...` and v6 vs `65585305:...`: identical. Tests pass (v5/v6 upgrade byte-identical to bundled v7, edited copy kept).

## demo-persona-v7-length-pacing-palette — VERIFIED
- Frontmatter seedVersion 7, description per spec; tools line unchanged. <length_and_pacing> at md:49-56 between audience_and_language and script_first. Absence check for `content="30"`, `duration: 30`, `np.zeros(30 * sr`, `a 30-second animated demo`: clean.
- Whiteboard bullet: >=6 elements, #D62828/#E4471C/#F77F00; character section defers to it. shippedPersonaSeeds.cjs:379 seed-v7 present; manifest test green.
- Read end to end: 30 s and 60 s rules agree (words 70-80 / 140-160; keystones 5-6 / 8-12 at >=5 s each; D used in meta, smDemo.duration, np.zeros(D*sr), process steps 5/7/9). Macro v5 prompt ("Video length: 60" -> 60 s, else 30) and the select's 'Video length: 60' line match the persona trigger text exactly. Live 60 s end-to-end check not in scope.

## Findings
- Critical: none. Important: none.
- Minor: persona md:52 says the "old 4.3 s keystones" — historical rationale text the model reads each run; harmless but could be trimmed.
- Minor: 30 s with 6 keystones at the 5 s floor leaves zero slack; the persona permits 5-6 so the model can choose 5.
- Security/code review: self-reviewed; no new input handling beyond a bounded constant change; no secrets or paths.
