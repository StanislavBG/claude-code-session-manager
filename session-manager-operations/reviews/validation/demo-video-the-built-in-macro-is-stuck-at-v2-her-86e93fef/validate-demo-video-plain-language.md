# Validation: builtin-macro-upgrade-by-content, demo-video-persona-v5-plain-language

Base: c4744b46bc059e024f3a974239de3f00d400b8d3. Landed commits: 112fa08f (macro), cdbdf018 (persona).

## builtin-macro-upgrade-by-content — VERIFIED
- `builtinMacros.cjs`: both entries have a frozen `priorPrompts` (checked with `Object.isFrozen`). `builtin-project-home` has 0 entries. `builtin-demo-video` has 3 entries of 246, 325 and 438 characters. `builtinVersion` is 1 and 4, and `prompt` is unchanged.
- Each `priorPrompts` entry is byte-identical to the prompt in `git show 21742a2f|93091f6f|fe658303:src/main/lib/builtinMacros.cjs`. I compared them by script and all three returned true.
- `macroLibrary.cjs`: `isShippedCopy` compares label, agentName, tag and `priorPrompts.includes(prompt)`. `neverEdited = updatedAt === createdAt || isShippedCopy(stored, b)`. The upgrade body is untouched (it spreads `...stored` and resets `updatedAt`).
- `macroLibrary.test.cjs:328-396` holds all seven named tests, including the real `saveMacro` test at :336 and the real-`BUILTIN_MACROS` version-count test at :386. The gate passes.
- Doc comments updated in `macroLibrary.cjs` and in the `builtinMacros.cjs` header, and both state the `priorPrompts` rule.
- Gate: `vitest run macroLibrary + builtinMacros` passed (89 tests across the four files in the combined gate run).

## demo-video-persona-v5-plain-language — VERIFIED
- `demo-video-builder.md` has `seedVersion: 5`. The diff shows no change to model, effort, tools, title or description.
- The diff against Base contains exactly the 13 listed replacements and nothing else.
- Sections: the diff restores `</output_contract>`, `<audio_policy>`, `</audio_policy>` and `<process>`, and fixes both runaway backtick references. The balance test passes.
- Output contract: the no-network list, system font stack, `prefers-reduced-motion` and `Under 2 MB total` are back. The `Never retype the base64 audio` bullet ends `<audio_policy>`.
- `</audience_and_language>` closes at char 2382 and `</call_to_action>` at 3680, both inside 6000 (body is 14425 chars). `<script_first>` no longer mentions get-started. The closing card and `<process>` steps 3, 7 and 9 point at the new sections.
- `shippedPersonaSeeds.cjs` gained one `seed-v5` entry, and `seedAgentPersonas.test.cjs` passes.
- `builtinMacros.test.cjs:39-91` pins seedVersion 5 and has the five new tests. `conventions.md` gained the subsection and the Avoid entry.
- Gate: `vitest run builtinMacros + seedAgentPersonas + seedValidatorPersona` passed. `npm run lint:docs` printed `doc-hierarchy: ok`.

## Full unit suite
- All `SM_*` variables unset (0 remained). `npx vitest run` gave 837 files passed, 7960 tests passed, 1 skipped, 0 failed. No Base re-run was needed.

## Review of the combined diff
Self-review only (correctness, input handling, secrets, path traversal, duplication). I found no secrets, no path handling and no unsafe input. `isShippedCopy` is a pure string comparison.

## Findings
- Critical: none.
- Important: none.
- Minor:
  - `macroLibrary.cjs:~308-322`: the `ensureBuiltins` doc comment now sits above the `isShippedCopy` comment instead of directly above `ensureBuiltins`, so JSDoc tools attach it to the wrong function.
  - The new `priorPrompts` rule is enforced only by a test over the real `BUILTIN_MACROS`. A hand-edited prompt that moves nothing into `priorPrompts` is caught only if `builtinVersion` also isn't bumped consistently.
  - The persona body stays over the 6000-char intake cap by design (14425). Its must-have rules sit above the cut and a test pins that.
