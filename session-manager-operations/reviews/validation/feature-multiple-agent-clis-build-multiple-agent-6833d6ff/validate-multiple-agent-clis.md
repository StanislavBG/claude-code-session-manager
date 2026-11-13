# Validation: multiple agent CLIs (PRDs 3002–3021, 3023, 3024)

Base: 746f2ae31bc4ff0d35fd8d6421fd6241d9214593 (63 commits to HEAD; combined diff also carries unrelated plans — Epic changes view, app preview, md-network explorer — not judged here).

## Gate evidence (all re-run in the foreground, SM_* env unset)
- One combined `vitest run` over every gate test file of all 22 PRDs: 85 files / 1150 tests passed.
- `npm run typecheck` (tsc + tsconfig.main.json): exit 0.
- `lint:selectors` OK (743 files), `lint:hooks` OK (380 files), `lint:docs` ok (35 files linted).
- 3021-fix gate: `grep "agentCliModel?: string"` hits code-map.md:108.
- `wc -c CLAUDE.md` = 12000 (at budget, not over).
- Full `npm run test:unit`: 3 failed / 10058 passed (see Findings).

## Per-PRD verdicts
Each: listed files exist and the PRD's gate passes (above).
- agent-cli-event-contract — VERIFIED. agentCliEvents.cjs (94 lines); `isAgentCliId`/`isNonClaudeAgentCli` consumed by epicMint.cjs:48, chatRunner.cjs:60.
- agent-cli-registry-detect — VERIFIED. agentCliRegistry.cjs (213 lines) + test green.
- agent-cli-codex-adapter — VERIFIED. adapters/codex.cjs + fixture + test green.
- agent-cli-gemini-adapter — VERIFIED. adapters/gemini.cjs + fixture + test green.
- agent-cli-antigravity-adapter — VERIFIED. adapters/antigravity.cjs + fixture + test green.
- agent-cli-cursor-adapter — VERIFIED. adapters/cursor.cjs + fixture + test green.
- agent-cli-opencode-adapter — VERIFIED. adapters/opencode.cjs + fixture + test green (fixtures only; no live CLI probe run here).
- epic-agent-cli-schema-fields — VERIFIED. promptSessionSchema.cjs:103,105 (`agentCli`, `agentCliModel`); typecheck green.
- epic-agent-cli-mint-rules — VERIFIED. epicMint.cjs:60-79 validates id, model regex, rejects restore into non-Claude; :318 forces developLoop=false.
- epic-agent-cli-create-ipc — VERIFIED. ipcSchemas.cjs:247,249 enum + model bounds; handler test and cross-boundary spec green.
- agent-cli-session-store — VERIFIED. agentCliSessionStore.cjs (151 lines) + test green.
- chat-runner-agent-cli-turn — VERIFIED. chatRunner.cjs:608 branch, :61 planAgentCliTurn, :62 writeNativeSession; legacy chatRunner specs still green.
- transcripts-agent-cli-feed — VERIFIED. transcripts.cjs:43-63 agent-CLI JSONL wins when present.
- agent-cli-ipc-terminal-command — VERIFIED. agentCliIpc.cjs (109 lines); preload/api.d.ts updated; ipc-web-remote spec green.
- epic-terminal-agent-cli-launch — VERIFIED. EpicTerminalPane.tsx + test green; typecheck and lints green.
- epic-agent-cli-chip — VERIFIED. agentCliCatalog.ts + parity test green.
- new-session-agent-cli-picker — VERIFIED. AgentCliPicker.tsx + NewEpicCard tests green.
- agent-cli-claude-coupled-guards — VERIFIED. chatBootRecovery.cjs:140 skips non-Claude; archivedTranscript.cjs:104, epicReopen.cjs:89 branch on isNonClaudeAgentCli.
- docs-agent-cli-domain-model — VERIFIED. CLAUDE.md lines now say "agent-CLI session" / three independent selections; lint:docs ok; size 12000.
- docs-agent-cli-code-map — VERIFIED. code-map.md:108 documents agentCli/agentCliModel (incl. 3021-fix); lint:docs ok.
- web-remote-agent-cli-transcript — VERIFIED. remoteTranscriptTail.cjs:63-85 `agentCliTranscriptPath`; test + ipc-web-remote spec green.
- epic-spawn-plan-agent-cli-worktree-guard — VERIFIED. epicSpawnPlan.cjs:115 refuses non-Claude spawn when worktree gone; epicSpawnPlan/epicSpawnCwd tests green.

## Findings
### Critical
- none
### Important
- `src/main/lib/agent-cli/agentCliSessionStore.cjs:23` — `path.join(os.homedir(), '.claude', 'session-manager', 'agent-cli')` trips `scripts/check-ops-path-literals.cjs` (LIVE_ROOT_LITERAL outside schedulerPaths.cjs). Makes `scripts/__tests__/check-ops-path-literals.test.cjs > the real repo tree is clean` red in full `test:unit`; reproduced in isolation. Fix: route through schedulerPaths or allowlist the path.
### Minor
- Two full-suite reds are load flakes, passing when re-run alone: `scheduler-resume-recovery-saturated.test.cjs` (idle CPU) and `timeoutShim.test.cjs` (grandchild kill). Not plan-related.
- OpenCode (and other CLI) adapters verified against fixtures only; the plan's live no-login OpenCode probe was not run by this validator.
- Foreign working-tree deletions of project-pages/home.html and demo-video/index.html appear in this worktree; not touched.
- Code review/security review: self-reviewed the agent-cli diff — argv-based spawning, model string regex-validated at mint (epicMint.cjs:77) and IPC bounds (ipcSchemas.cjs:249); no secrets or path traversal spotted.
