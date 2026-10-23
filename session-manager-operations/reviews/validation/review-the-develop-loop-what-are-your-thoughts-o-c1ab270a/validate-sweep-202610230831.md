# Validation: atomic-write-spec-invariant (PRD 2177)

Base: eb10e015. Commit found: 1c562a8f (`tests/unit/atomic-write.spec.ts`, 5+/3-, only file changed).

## atomic-write-spec-invariant — VERIFIED

- AC1 (no `atomicWriteJsonSync` requirement; still fails on inline tmp+renameSync; accepts direct call): `git show 1c562a8f` — wrapper regex removed, added `not.toMatch(/renameSync\(\s*\w*tmp\w*\s*,/i)` and `toMatch(/config\.writeJsonSync\(/)` (spec ~l.144-147); existing `fs.writeFileSync(tmp` / `fsp.writeFile(tmp` checks kept. `src/main/scheduler.cjs:576,682,4252` use `config.writeJsonSync(` directly; only `renameSync` at :741 is heartbeat rotation (not tmp-named), so no false positive.
- AC2 (spec passes at HEAD): `timeout 300 npx vitest run tests/unit/atomic-write.spec.ts` → 1 file, 9/9 passed.
- AC3 (no production changes): `git show 1c562a8f --stat` → only the spec file.
- Gate re-run: same vitest command, exit 0.

## Findings

- Minor: `tests/unit/atomic-write.spec.ts:~144` — renameSync guard only matches a tmp-named first argument; an inline recipe using a differently named temp var would slip past. Negative case (deliberately bad file) was not demonstrated.
- Minor: `/code-review` and `/security-review` not run; self-reviewed the one-file test-only diff: no unsafe input, secrets, or path handling.
