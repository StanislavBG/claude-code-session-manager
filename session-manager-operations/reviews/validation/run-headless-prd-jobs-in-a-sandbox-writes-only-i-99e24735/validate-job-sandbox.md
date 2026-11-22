# Validation: job-sandbox plan (PRDs 3625-3628)

Base: a878503d0fd091b265ddb5daf30069850169d516. Commits: 76d543fc (policy), 00069661 (wiring), 697784d8 (probe), 20804e10 (doc).
Run level: this host lacks `socat`, so this validator run itself was at tool-rules level (not os-sandbox). No sandbox write or network refusal affected any gate.
/code-review and /security-review were not run as separate commands. I self-reviewed the diff for these areas: correctness, path handling, secrets and unsafe input. Nothing found beyond the Minor below.

## job-sandbox-policy — VERIFIED
- 'use strict' + // @ts-check: jobSandboxPolicy.cjs:1-2; only `node:path` required (:28); exports :182-187.
- Four deny rules via `//` + abs without leading slash: :72-76 (`/${p}` prefixed by `/`).
- os-sandbox argv `['--permission-mode', mode, '--settings', JSON]`, no bypass, enabled/failIfUnavailable/allowUnsandboxedCommands false/autoAllowBashIfSandboxed/strictAllowlist/allowedDomains: :145-179.
- tool-rules fallback with bypass, deny-only settings, reason strings: :123-143.
- sandboxDependencies linux bwrap+socat, darwin sandbox-exec, else `unsupported platform: <name>`: :56-70. TypeError naming the field: :83-89.
- lib-layout.json:80 maps jobSandboxPolicy → claude. Tests present.
- Gate: vitest jobSandboxPolicy.test.cjs → passed (6 files / 88 tests combined run); `npm run lint` ran clean (tail showed no errors).

## job-sandbox-spawn-wiring — VERIFIED
- scheduler.cjs:5028 `sandboxArgs = null`; :5037 replaces bypass at the same position; null/empty falls back to the literal flag.
- Byte-identical: the base argv (a878503d scheduler.cjs:4917-4931) differs from the current one only by the pre-existing, unrelated `jsonSchema` slot (validator-verdict plan) and this slot; with both unset the element order is identical.
- executeJob computes policy once (:5634-5641) with agentType||'dev-lead', spawnCwd, cwd, os.homedir/tmpdir, cached deps; passes `sandboxArgs: sandboxPolicy.argv` (:5646).
- resolveJobSandboxDeps (:5063-5079): cached; linux bwrap self-test with 5000 ms timeout (`--unshare-net --unshare-pid -- true`); SM_JOB_SANDBOX=0 → 'disabled by SM_JOB_SANDBOX=0'; never throws.
- Log line :5643; `sandbox: sandboxMeta` in meta writes at :5664, :5716, :5779.
- spawnInvestigation uses agentType 'investigation' argv (:6326).
- Gate: five vitest files incl. scheduler-sandbox-spawn → passed; `npm run typecheck` printed no errors.

## job-sandbox-live-probe — VERIFIED
- classifyProbeRun exported; tests included. `--dry-run` printed JSON with keys deps, profiles{validator,dev-lead}; exit 0; the only `spawn` call is in runClaude (not reached under --dry-run).
- Live without deps: printed `SKIP: missing socat` + `sudo apt install socat`; exit 2.
- Live path: haiku pinned, `--strict-mcp-config`, `--output-format text`, prompt via stdin, SM_KG_INTERNAL=1, 240 s timeout (read; not run live — no socat).
- package.json:54 `probe:job-sandbox`; scripts/README.md:30 entry.
- Gate: vitest job-sandbox-probe.test.cjs passed; dry-run exit 0.

## job-sandbox-policy-doc — VERIFIED
- scheduler-operations.md `## 11. Job sandbox` (line 509, after §10 at :496): levels, secret list (matches SANDBOX_SECRET_PATHS exactly), write roots (worktree, projectRoot/.git, tmpDir, ~/.npm, ~/.cache, node_modules/.vite, .vitest — matches :159-167), profiles (validator default/none; dev-lead acceptEdits/registry.npmjs.org — matches :51-52), SM_JOB_SANDBOX=0, meta key, probe command, evidence, six residual risks.
- Persona table: 8 rows = the 8 files in src/seed/agents/; web for competitive-analyst/researcher (tools: lines confirmed).
- CLAUDE.md line 103 is the one added law; `wc -c CLAUDE.md` = 11425 (≤12000).
- personaToolScope.cjs header lines 15-18 updated, comment only.
- Gate: `npm run lint:docs` → doc-hierarchy ok.

## Findings
### Critical
- none
### Important
- none
### Minor
- scheduler-operations.md §11 "Every job's run meta JSON carries a `sandbox` key" overstates: the two early meta writes (scheduler.cjs:5189, :5390, before the policy resolves) omit it, as the PRD intended. Suggest "every run that reaches spawn".
- Live os-sandbox containment is unproven on this host (socat missing); `npm run probe:job-sandbox` could not run live. Install socat and run it once.
