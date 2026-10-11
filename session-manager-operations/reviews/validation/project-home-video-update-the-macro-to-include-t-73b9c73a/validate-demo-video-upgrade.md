# Validation: demo video upgrade (plan pl-mv35bbni / pl-mv35bh30)

Base: e1f3518e1ac14d0b82613c3268eb74a50d2eda52. Commits: 8891557c (1816), fe825390 (1817), dc226e25 (1818), 82ae10ee (1819). PRD files read from `prds-archived/`.

## demo-video-character-styles-opus — REFUTED
- `src/main/lib/builtinMacros.cjs:35` builtinVersion 4; prompt has "Generate a character and cute animated JavaScript video", theme/purpose, script-first, four style names, `Video style: <name>`, Kokoro, `project_demo_video_write` + `htmlPath` — OK.
- `src/seed/agents/demo-video-builder.md:6-8` model opus, effort max, seedVersion 4 — OK. Four new sections `<script_first>`, `<character>`, `<styles>`, `<dynamic_elements>` present, content matches notes — OK.
- **FAIL: `<audio_policy>` content is not preserved verbatim.** The diff truncated the file mid-sentence at `:162` (`- Save the built file by path (see \`<process>`). The rest of that bullet (`\` step 6). Never retype the base64 audio…`), the closing `</audio_policy>` and the opening `<process>` tag are gone. `grep -n 'audio_policy>\|<process>'` shows no `</audio_policy>` and no standalone `<process>`; `</process>` remains at `:182`. v3 had them at lines 120-124.
- shippedPersonaSeeds.cjs:279,290: v3 (e477754c) and v4 (`seed-v4`, sha 247f5244…) entries present; the v4 hash was computed over the corrupted body, so it pins the defect.
- builtinMacros.test.cjs exists, asserts version/prompt/styles/persona fm — OK, but it does not check tag balance, which is why the corruption passed.
- Gate re-run: `vitest run builtinMacros.test.cjs seedAgentPersonas.test.cjs macroLibrary.test.cjs` → 3 files / 49 tests passed.

## macro-cost-warning-helper — VERIFIED
- `src/renderer/lib/macroCost.ts:5` exports `HIGH_COST_EFFORTS = ['xhigh','max']`; `:7-15` null for undefined persona / null effort / non-high effort; message has label, agentName, model (`'the default model'` when null), effort, ends "Continue?".
- `__tests__/macroCost.test.ts` covers all listed cases. Gate: tests pass (with 1818/1819 tests: 3 files / 38 tests), `npm run typecheck` exit 0.

## demo-video-style-picker — VERIFIED
- `ProjectPagesSection.tsx:22` `DEMO_VIDEO_STYLES` = Auto, Professional, Fun, Animated whiteboard, Kinetic typography; `:44,47` hook above any early return; `:49-54` composes `Video style: <Label>` + `\n` + trimmed extra, undefined when empty; `:60-76` select `data-testid="project-home-demo-style"`, `aria-label="Video style"`, disabled when launching, only for `builtin-demo-video`.
- Tests added for empty/populated presence, Fun, Animated whiteboard + extra, Auto, disabled. Gate: tests, typecheck, `npm run lint` all exit 0.

## macro-cost-confirm-on-launch — VERIFIED
- `useMacroLaunch.ts:60-61` warning computed after the persona-not-found check and before `setLaunching`; `window.confirm` false → return. Resume path returns earlier (header note `:17-18`). Four tests in `useMacroLaunch.test.tsx` as required. Gate: tests, typecheck, lint exit 0.

## Cross-PRD check
- Style names: macro prompt (`builtinMacros.cjs:35`), persona `<styles>` bullets, and picker options all use Professional / Fun / Animated whiteboard / Kinetic typography. Match exactly.
- Line format `Video style: <name>`: picker emits `Video style: ${style}` (`ProjectPagesSection.tsx:50`); persona and macro both read `Video style: <name>`. Match.

## Findings
### Critical
- (none)
### Important
- `src/seed/agents/demo-video-builder.md:162` — truncated bullet; `</audio_policy>` and `<process>` tags missing (see 1816). The persona's process section is unopened and the audio-policy bullet lost its tail, including the "never retype base64 audio" warning and the pointer to the save step. Fix: restore the v3 text of that bullet, `</audio_policy>`, blank line, `<process>`; then regenerate the v4 entry in `src/main/lib/shippedPersonaSeeds.cjs:290` (hash will change).
### Minor
- `builtinMacros.test.cjs` has no tag-balance assertion for the persona; add one (every `<x>` has `</x>`) to stop recurrence.
- Pre-existing, not from this plan: `:97` has an unclosed backtick around `<audio_policy>` (also in v3 line 55).
- Untracked stray `<path>` file in the worktree root (known sqlite MCP placeholder); not part of the plan.
- `/code-review` and `/security-review` not run separately; self-reviewed the diff: no secrets, no path traversal or unsafe input handling; `window.confirm` is the only new effect.
