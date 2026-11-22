# Validation: job-sandbox-probe-leak-check-test (PRD 3708)

Base: 5be58ddc. Commit: a1ea99d1 (touches only the two PRD files).

## job-sandbox-probe-leak-check-test — VERIFIED
- AC1: `scripts/job-sandbox-probe.cjs:253` defines `leakedProjectFolders(cwds, { homeDir = os.homedir(), exists = fs.existsSync } = {})`. It maps to `path.join(homeDir,'.claude','projects',projectFolderName(cwd))` and filters by `exists`, in input order. It is exported in `module.exports` (line 369).
- AC2: `main()` (~line 351) calls `leakedProjectFolders(cwds)` and prints `LEAK: project folder <path>` per result. It returns 1 when `bad || leaked.length`. The inline loop is gone; the format is unchanged.
- AC3: `scripts/__tests__/job-sandbox-probe.test.cjs:92-113` has three tests. One stubs `exists` true for one of two cwds and checks the result under the given homeDir. One has `exists` always false and expects `[]`. One uses a dotted/slashed cwd and checks the name against `projectFolderName`.
- Gate (re-run): vitest 17/17 passed; `node scripts/job-sandbox-probe.cjs --dry-run` exit 0.
- Review: self-review of the diff (no unsafe input handling; paths built with path.join from fixed segments; no secrets; reuses `projectFolderName`).

## Findings
- Critical: none.
- Important: none.
- Minor: none.
