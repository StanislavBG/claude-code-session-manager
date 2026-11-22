# Validation: job sandbox private tmp fix wave

Base: d4d5c24954ae366f4fc69d3262d20978299c896b. Commits: edda7cab (3670), 691a5ed5 (3671), 8e51ed0e (3672).
Run level: this validator ran at tool-rules (socat not installed, /tmp writes allowed), so the live probe ran un-nested and was a real proof, not a nested-sandbox failure.

## job-sandbox-private-tmp — VERIFIED
- `sandboxChildEnv` exported, pure, returns TMPDIR/TMP/TEMP for os-sandbox and `{}` otherwise: src/main/lib/claude/jobSandboxPolicy.cjs (edda7cab diff).
- `executeJob` makes `fs.mkdtempSync(path.join(os.tmpdir(),'smj-'))` only when `deps.available` and `SANDBOX_PROFILES` has the agentType (default dev-lead), passes `tmpDir: sandboxTmpDir || os.tmpdir()`: src/main/scheduler.cjs ~5725-5745.
- `Object.assign(childEnv, sandboxChildEnv(...))` runs after cleanChildEnv; tool-rules gets `{}`.
- `removeSandboxTmp()` (rmSync recursive/force in try/catch) is called on argv-too-large, spawn failure and child exit, each after the meta write.
- Meta `sandbox: { ...summary, tmpDir }`; log line adds `tmp=<dir|none>`.
- Tests added in jobSandboxPolicy.test.cjs (both levels) and scheduler-sandbox-spawn.test.cjs (allowWrite has private dir, not os.tmpdir()).
- Gate: vitest 5 listed files plus probe test, 6 files / 95 tests passed; `npm run typecheck` exit 0.

## job-sandbox-probe-private-tmp-and-temp-socat — VERIFIED
- `--dry-run` JSON includes each profile's `tmpDir` (/tmp/smj-PbmLq3, /tmp/smj-MaZZDm); the dirs are removed afterwards.
- Live: `node scripts/job-sandbox-probe.cjs --fetch-socat` printed "Using socat unpacked (not installed)" and then validator os-sandbox none none exit 0; dev-lead os-sandbox none none exit 0; "PASS: no escapes, controls ok"; EXIT=0.
- After the run, no /tmp/smj-*, /tmp/sm-socat-* or ~/.sm-sbx-probe-* leftovers.
- Probe test file passes (included in the 95 tests above); I did not separately re-read scripts/README.md line by line beyond the diff stat (2 lines changed).

## job-sandbox-doc-private-tmp — VERIFIED
- Section 11 (8e51ed0e) names `/tmp/smj-XXXXXX`, TMPDIR/TMP/TEMP, removal at job end and the os.tmpdir() fallback. This matches scheduler.cjs.
- The meta sentence lists `{ level, profile, network, reason, tmpDir }`, and says the two pre-policy meta writes omit it. This matches the code, where the sandbox key is added only after policy resolution.
- Log line format `tmp=…` matches.
- The doc has the 2026-11-22 live evidence, the result table (same as my run), and the proof-only / `sudo apt install socat` note.
- Gate: `npm run lint:docs` ok.

## Findings
### Critical
none
### Important
none
### Minor
- A `/tmp/sm-sbx-probe-LrKw` dir exists after the run. It is probably the probe's dry-run or test fixture, or a sibling job's, and I did not trace the owner; a leak check by the probe author is worthwhile. Not confirmed as a defect.
- Doc table records HEAD `691a5ed5` rather than the doc PRD's own HEAD. This is harmless because the probe code is unchanged since.
- Combined diff reviewed by hand (no slash review tools were invoked): no shell use, argv-array spawns, temp dirs under os.tmpdir(); no secrets or path-traversal issues seen.
