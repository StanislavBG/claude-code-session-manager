# Validation: context packs plan

Base `76fe9825` (the plan's own commits are `6ca5d9f0..7dee1e78`; the base..HEAD range also holds unrelated md-review commits). Final commit checked: `7dee1e78`. All PRD files were found in `prds-archived/`. Env: `SM_*` unset for the full suite.

## Gates re-run (all foreground)
- One vitest run over every gate test file: 18 files, 357 tests passed. This covers packCatalog, shippedPacks, packSpawnArgs, packsIpc, promptSessionSchema, createEpicHandler, epicMint, chatRunner-packs, chatRunner-develop-loop-off, chatRunner-agent-cli, scheduler-prd-persona-spawn, scheduler-resume-recovery, personaToolScopeMcpConfig, the preload tests, groundingBoard, NewEpicCard and epicLaunchCommand.
- `npm run typecheck`, `lint:docs`, `lint:selectors` and `lint:hooks` all exit 0.
- `CLAUDE.md` is 11998 bytes (limit 12000).
- Pack laws: apple-swift-core 1410 chars, apple-design 1582 chars (limit 2000). All four SKILL.md files are under 5100 chars (limit 6000).

## Per PRD
- **pack-catalog-loader — VERIFIED.** `packCatalog.cjs` (120 lines) and its two tests exist. The shipped-packs test passes with errors empty. `packCatalog.test.cjs` has a lint smell (see Important 1).
- **prompt-session-packs-field — VERIFIED.** Schema, ipcSchemas and createEpic carry `packs`. `epicMint.cjs:51-72` dedups packs, writes the key only when non-empty, and drops packs for non-Claude CLIs. Schema and handler tests pass.
- **pack-apple-swift-core — VERIFIED.** plugin.json, sm-pack.json, laws.md and 2 skills are present. `check-doc-hierarchy.cjs` exempts `plugins/packs/`, and `plugins/CLAUDE.md` is updated. `lint:docs` is green.
- **pack-apple-design — VERIFIED.** Same file layout, 2 skills, laws under the cap. The shipped-packs test passes.
- **pack-spawn-args — VERIFIED.** `packSpawnArgs.cjs:48-49` skips unknown ids and ids with a platform mismatch. Directories come only from catalog entries. Its test passes.
- **wire-packs-chat-spawn — VERIFIED.** `chatRunner.cjs:~648-725` looks up the Epic once per turn. It appends `...packPluginDirArgs` and `--append-system-prompt <laws>` after the loop-off args and before `--output-format`. A failure is caught, logged and launches without packs. `chatRunner-packs.test.cjs` and the loop-off test pass.
- **wire-packs-job-spawn — VERIFIED.** `buildClaudeSpawnArgs` takes `pluginDirArgs`, placed before `--dangerously-skip-permissions`. `executeJob` calls `findEpicById(epicId||sourcePromptId)` once per spawn, and `findEpicById` is exported at `agentModelResolve.cjs:93`. Laws are appended after the persona body. An error logs one `[scheduler]` line. `scheduler-packs-spawn.test.cjs` passes.
- **packs-list-ipc — VERIFIED.** `packsIpc.cjs` handles `packs:list`. It is registered in `index.cjs`, exposed in preload, typed in `api.d.ts`, and has an `apiSurface.json` row. The surface tests pass.
- **grounding-board-packs — VERIFIED.** `groundingBoard.ts` adds the Context packs item, the `packs · N` summary and the new persona label. The test passes.
- **new-session-pack-picker — VERIFIED.** NewEpicCard, promptSessions, epicDraft and api.d.ts are changed. The NewEpicCard test passes, as do lint:selectors and lint:hooks.
- **domain-model-packs-law — VERIFIED.** domain-model.md has the Context packs section, CLAUDE.md has the law line, and the size and lint:docs gates pass.
- **wire-packs-terminal-launch — VERIFIED.** `packs:terminal-args`, `epicLaunchCommand` and `EpicTerminalPane` are changed. The packsIpc and epicLaunchCommand tests pass, as do the surface tests.

## Real-path probe
`claude -p --model claude-haiku-5-5 --plugin-dir <repo>/plugins/packs/apple-swift-core --append-system-prompt probe` ran from a fresh temp directory and exited with rc 0. The init line contained:
- `"plugins":[{"name":"sm-pack-apple-swift-core","path":".../plugins/packs/apple-swift-core","source":"sm-pack-apple-swift-core@inline","version":"0.1.0"},...`
- `"skills":[...,"sm-pack-apple-swift-core:swift-concurrency","sm-pack-apple-swift-core:swiftui-state-and-navigation",...]`

## Full suite and lint
- **`npm run test:unit` — NOT green.** The first full run had 2 failures. A second full run had 1 failure.
  - `epicMint.test.cjs` "restore of an archived claudeSessionId…" failed once under full-suite load. It passes alone (59/59) and in the second full run, so it is flaky under load.
  - `scripts/__tests__/dev-plugin-skillset.test.cjs` "plugin.json version equals marketplace entry version" fails in both runs, expecting 0.4.0 and getting 0.4.1. This is not from this plan: `plugins/session-manager-dev` has no commit in the plan range, and it is the known plan 3139-3147 / 3140 marketplace.json mismatch (fix 3161 queued).
- **`npm run lint` — NOT green.** `lint:test-smells` reports `src/main/lib/packs/__tests__/packCatalog.test.cjs: new no-assert smell`. This comes from this plan (PRD 3148).

## Findings
### Critical
- none.
### Important
1. `src/main/lib/packs/__tests__/packCatalog.test.cjs` has a no-assert smell (20 tests, one or more without an assertion). `npm run lint` fails, so the plan's lint criterion is unmet. Fix the test; don't allowlist it.
2. The `dev-plugin-skillset` red (marketplace 0.4.0 vs plugin 0.4.1) leaves the full-suite criterion unmet. It is not caused by packs and is covered by fix 3161.
### Minor
1. `epicMint.test.cjs` restore-refusal test is flaky under full-suite load (passes alone).
2. The base..HEAD range includes unrelated md-review commits (989bdb7f etc.), so the combined diff was reviewed only over the 12 pack commits.
3. Self-review of the diff found no secrets, no path traversal (directories only from catalog entries), and no `shell:true`. `/code-review` and `/security-review` were not run separately.

## Verdicts
All 12 PRDs hold against their own acceptance criteria and gates. The plan-level lint and full-suite criteria are red for the reasons above.
