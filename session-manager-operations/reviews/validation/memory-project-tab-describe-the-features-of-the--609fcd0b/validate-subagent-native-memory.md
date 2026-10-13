# Validation: memory-store-view-extract / subagent-memory-native-view / retire-legacy-agent-memory / memory-learning-content

Base: 0e53d9bd07a6b6405398ec95875d1c4e00c95160 (given). Commits: 96b439c1, 1beae566, 7950957a, 66ba2386 (+ merges).
Gates re-run in a worktree with node_modules symlinked to the main checkout (TMPDIR scratch):
- vitest (MemoryStoreView, MemoryIndexHealth, MemoryNaturalPanel.voiceButton, SubagentMemoryView, dataModelErd): 5 files / 33 tests passed.
- `npm run typecheck`: exit 0. `npm run lint`: ends clean ("e2e budget ok 19/19", page-stewards clean).

## memory-store-view-extract — VERIFIED
- MemoryStoreView exported with `target`, toolbarExtra, enableNatural, enableClusters: memory/MemoryStoreView.tsx:40, props :25-31.
- Every memory.* call passes target: MemoryStoreView.tsx:70,80,123,151,165,392.
- Memory.tsx renders MemoryStoreView with workspace/cwd target + enableNatural/enableClusters: Memory.tsx:57-66; `grep NewMemoryForm Memory.tsx` empty (now at MemoryStoreView.tsx:365).
- Test file present and passing (incl. agent-target passthrough). Gate green.

## subagent-memory-native-view — VERIFIED
- No useAgentMemory / agentMemory / AgentMemoryCategory in SubagentMemoryView.tsx (grep empty); list via memory.agents.
- memoryScope set → MemoryStoreView target `{cwd, agent:{name, scope}}` + scope note: SubagentMemoryView.tsx:15-17, :99.
- memoryScope null → EmptyState with enable hint, no write controls: :77-90.
- Empty agent list EmptyState :70-75. SubagentMemoryView.test.tsx passes. Gate green.

## retire-legacy-agent-memory — VERIFIED
- agentMemory.cjs, state/agentMemory.ts, its test deleted (ls: No such file); index.cjs require + register removed (diff).
- ipcSchemas, preload/index.cjs agentMemory namespace removed (diff); `grep -rnE 'agentMemory|AgentMemory' src scripts` only hits resolveAgentMemoryDir (native resolver); no api.d.ts hits; allowlist entry removed in check-ops-path-literals.cjs.
- dataModelErd.ts:590,592 path/definedIn match spec; dataModelErd.test.ts passes.
- Absence check `agent-memory:` / `useAgentMemory` across src scripts web web-remote plugins: clean. No deletion of ~/.claude/session-manager/agent-memory (grep of src: none).
- Typecheck/lint green.

## memory-learning-content — VERIFIED
- learningContent.ts 'memory': headline, intro naming ~/.claude/projects/<project>/memory/, MEMORY.md index, 200 lines / 25KB; no legacy path/categories. Four required sections + tips incl. "Auto memory off means nothing here is read."
- screenComponents.tsx 'memory' intro updated per criterion. Typecheck/lint green.

## Findings
Critical: none.
Important: none.
Minor:
- Self-review of combined diff (agent name validated by NAME_RE and '.'/'..' rejection in memoryDirResolve.cjs:50; project scopes require root; root passed through config.validatePath, memoryTool.cjs:~90-100): no path traversal or secrets found.
- Gate runs required symlinking node_modules into the job worktree (gitignored, not committed); stray untracked `<path>` file (sqlite MCP placeholder) left unstaged.
- `/code-review` / `/security-review` were not run as separate passes; review was manual.
