# Validation: job-sandbox-probe-no-project-folders

Base: d58913dd (known). Commit for PRD 3692: 2af3dbe6 (scripts/job-sandbox-probe.cjs, scripts/__tests__/job-sandbox-probe.test.cjs).
PRD file: prds-archived/3692-job-sandbox-probe-no-project-folders.md.

## 3692-job-sandbox-probe-no-project-folders — VERIFIED

- probeChildEnv exported, returns `{ ...baseEnv, SM_KG_INTERNAL:'1', CLAUDE_CODE_DISABLE_AUTO_MEMORY:'1', ...sandboxChildEnv(policy,tmpDir) }`; the only live spawn env is `probeChildEnv({...process.env, PATH: searchPath}, built, tmpDir)` (diff of 2af3dbe6, main()).
- projectFolderName exported: `String(cwd).replace(/[^A-Za-z0-9]/g,'-')`.
- LEAK check: after results, each recorded cwd's `~/.claude/projects/<name>` is tested with existsSync; prints `LEAK: project folder <path>`, returns exit 1; no deletion code.
- Tests: vitest 14/14 pass (covers both levels and dotted/slashed paths).
- Gate re-run: vitest exit 0; `--dry-run` exit 0; `--fetch-socat` exit 0 (validator + dev-lead os-sandbox, no escapes, no failed controls).
- After my own live run: `ls ~/.claude/projects/-tmp-sm-sbx-probe-*` → no such file. Clean.

## Combined diff review
2 files, +66/−5. Self-review (no unsafe input handling, no secrets, no path traversal: paths come from the probe's own mkdtemp dirs). Reuses sandboxChildEnv.

## Findings
- Critical: none.
- Important: none.
- Minor: the LEAK branch has no automated test (it only runs in the live probe); it has not been observed to fire.
