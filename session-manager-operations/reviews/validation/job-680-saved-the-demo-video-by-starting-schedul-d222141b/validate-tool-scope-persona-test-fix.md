# Validation: validate-tool-scope-persona-test-fix

Base: aa3f3e92da8fb8bd9db0140f25bf0f3db1dd861e. HEAD at run: dafe1f4d (+ this record).

## builder-personas-no-reach-around (PRD 2604) — VERIFIED
- demo-video-builder.md:280-287: missing `project_video_write` = launch bug; say so, give HTML path, stop; forbids starting the MCP server, calling the admin API, hand-writing the file, any other workaround. First sentence (3 attempts) intact.
- project-home-builder.md:83-86: same text for `project_page_write`; first sentence intact.
- seedVersion: demo-video-builder 9 (demo-video-builder.md:8), project-home-builder 5 (:8).
- Gate `vitest run src/main/__tests__/seedAgentPersonas.test.cjs`: 1 file, 39 tests passed.
- Earlier refutation (builtinMacros seedVersion pin at 8): resolved. aa3f3e92 re-pinned it, then c7830ed5 changed it to a floor.
  builtinMacros.test.cjs:43-49 now asserts an integer seedVersion >= 9, so a future bump no longer reds the test.

## builtin-macros-test-follows-persona-version (PRD 2616) — VERIFIED
- builtinMacros.test.cjs:43 title is "demo-video-builder persona is opus / max / seedVersion 9 or later".
- :48-49 assert `Number.isInteger(Number(fm.seedVersion))` and `Number(fm.seedVersion) >= 9`. The opus/max assertions are unchanged.
- Gate `vitest run builtinMacros.test.cjs seedAgentPersonas.test.cjs`: 2 files, 49 tests passed.
- Product-file scope was not re-diffed individually; c7830ed5 is described as touching only the test file.

## Full-suite checks at HEAD
- `timeout 900 npm run test:unit`: 891 files passed, 8431 tests passed, 1 skipped, 0 failed. All 4 earlier out-of-plan reds are gone.
- `npm run typecheck`: pass (tsc root + main).
- `npm run lint`: FAIL (exit 1). `lint:main-ts-check` reports
  `src/main/lib/project-pages/playerBridge.cjs: starts with "// @ts-check" but is missing from tsconfig.main.json include`.
  Owning commit: 620d1bd7 (feat(project-pages): postMessage player bridge). That commit belongs to neither this plan nor the Project Home repair wave 2608-2614, so it does not refute these two PRDs.

## Findings
### Critical
- none
### Important
- `npm run lint` is red at HEAD. 620d1bd7 added playerBridge.cjs with `// @ts-check` but never added it to tsconfig.main.json `include`. Fix: add the path to the include list.
  I did not check whether the lint step runs earlier in the lint script chain.
### Minor
- `git status` shows a modified `session-manager-operations/project-pages/home.html`. It was carried in from the main tree and is not part of this work.
