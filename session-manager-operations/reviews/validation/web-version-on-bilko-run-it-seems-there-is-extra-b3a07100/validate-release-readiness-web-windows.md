# Validation: release readiness (web + windows)

Base 8577d06c, HEAD f724c30f. Private node_modules (symlink removed, `npm ci`). SM_* env unset for the full suite.

## remote-fence-native-realpath-win32 — VERIFIED
Commit f724c30f (only commit touching the PRD's paths).
- AC1: src/main/index.cjs:136 `realpath: (p) => require('./lib/insideHome.cjs').realpath(p)`; insideHome.cjs:37-40 uses `fs.realpathSync.native` with fallback, exported at :180. No second implementation.
- AC2: remoteIpcDispatch.cjs:71 strips `/[. ]+$/` per segment when win32 only; posix unchanged.
- AC3: remoteIpcDispatch.test.cjs:203-217 — CLAUDE~1/SESSIO~1 expansion refused, `.claude.json.` and `.ssh \id_ed25519` refused, posix `.claude.json.` allowed.
- AC4: ci.yml:91 ends with remoteIpcDispatch.test.cjs; ci-windows-job.test.cjs:23 is the same last entry.
- Gate: `vitest run remoteIpcDispatch ci-windows-job winPaths web-remote` → 18 files / 199 tests passed; `npm run typecheck` exit 0.

## Release readiness at HEAD — VERIFIED
- `npm run typecheck`: exit 0.
- `npm run test:unit`: **825 files passed, 7754 tests passed, 1 skipped (7755)**; no failing spec.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities, exit 0.
- `npm run build`: exit 0. `npm run build:web`: exit 0.
- Worktree clean after the runs.

## Findings
- Critical: none.
- Important: none.
- Minor: remoteIpcDispatch.cjs:71 trailing-dot stripping also collapses a segment of only dots (`..`) to empty, which is filtered out before the secret match. The containment check runs on the realpath, so this is not exploitable. Noted only.
- Minor: the combined diff also contains other Epics' fixes (chatRunner, epicWorktreeMint, scheduler tests). They were covered by the full suite, not reviewed line by line.
