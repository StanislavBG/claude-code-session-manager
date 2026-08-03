/**
 * Scheduler reliability: finish-protocol injection + commit-guard porcelain parse.
 *
 * These lock the two reliability guarantees added so the queue can be relied on
 * to finish work to a consistent bar (review → security-review → verify →
 * commit) and never silently mark an uncommitted job "completed".
 *
 * Source: src/main/scheduler.cjs (parsePorcelain, FINISH_PROTOCOL).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parsePorcelain, FINISH_PROTOCOL, computeCommittedDuringRun } = require('../../src/main/scheduler.cjs')

describe('parsePorcelain (commit guard)', () => {
  it('returns [] for an empty / clean tree', () => {
    expect(parsePorcelain('')).toEqual([])
    expect(parsePorcelain('\n')).toEqual([])
    expect(parsePorcelain(undefined)).toEqual([])
  })

  it('extracts paths across modified / added / untracked / renamed lines', () => {
    const out = [
      ' M src/a.ts',
      '?? src/new.ts',
      'A  src/added.ts',
      'R  old.ts -> new.ts',
    ].join('\n')
    expect(parsePorcelain(out)).toEqual([
      'src/a.ts',
      'src/new.ts',
      'src/added.ts',
      'old.ts -> new.ts',
    ])
  })

  it('a non-empty result is how the guard knows the COMMIT step did not run', () => {
    expect(parsePorcelain(' M f.ts').length).toBeGreaterThan(0)
  })
})

describe('FINISH_PROTOCOL', () => {
  it('mandates the exact review → security-review → verify → commit sequence', () => {
    expect(FINISH_PROTOCOL).toMatch(/\/code-review/)
    expect(FINISH_PROTOCOL).toMatch(/\/security-review/)
    expect(FINISH_PROTOCOL).toMatch(/git add <path>/)
    expect(FINISH_PROTOCOL).not.toMatch(/git add -A/)
    expect(FINISH_PROTOCOL).not.toMatch(/git add \./)
    expect(FINISH_PROTOCOL).not.toMatch(/git add --all/)
    // ordering: code-review before security-review before commit
    const iCode = FINISH_PROTOCOL.indexOf('/code-review')
    const iSec = FINISH_PROTOCOL.indexOf('/security-review')
    const iCommit = FINISH_PROTOCOL.indexOf('git commit')
    expect(iCode).toBeLessThan(iSec)
    expect(iSec).toBeLessThan(iCommit)
  })

  it('reinforces the no-bonus-work bound', () => {
    expect(FINISH_PROTOCOL).toMatch(/beyond the acceptance criteria/i)
  })
})

// Regression: PRD 599-sharp-osv-fix-batch-b committed real work on four
// non-starting branches, pushed, then checked its starting branch back out
// before exit — HEAD never moved on that branch, so the old HEAD-diff-only
// guard reported committedDuringRun=false and runVerify.cjs raised
// pass_no_commit on a fully-correct PASS-sentineled run. The live guard now
// falls back to committedInWindow (git log --all) whenever the HEAD-diff
// fast path finds nothing.
describe('computeCommittedDuringRun (live commit-guard)', () => {
  const dirs: string[] = []

  function initRepo() {
    const dir = mkdtempSync(join(tmpdir(), 'sm-commit-guard-'))
    dirs.push(dir)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git('init', '-q')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('checkout', '-q', '-b', 'main')
    return { dir, git }
  }

  // Base commit is stamped an hour in the past so it always sits outside the
  // run window (window start = "now", captured right after this commit) —
  // git's --since/--until has only second resolution, so without this the
  // base commit and the window boundary can land in the same second.
  function commitInPast(dir: string, git: (...args: string[]) => Buffer, file: string, message: string) {
    const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    execFileSync('sh', ['-c', `echo ${message.replace(/\s+/g, '_')} > ${file}`], { cwd: dir })
    git('add', '-A')
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: dir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: pastIso, GIT_COMMITTER_DATE: pastIso },
    })
  }

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()
      if (d) rmSync(d, { recursive: true, force: true })
    }
  })

  it('branch-hopping: HEAD unchanged on starting branch, but a commit landed on another branch within the window → true', async () => {
    const { dir, git } = initRepo()
    commitInPast(dir, git, 'f.txt', 'base')
    const headBefore = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim()
    const startedAt = new Date().toISOString()

    git('checkout', '-q', '-b', 'feature')
    execFileSync('sh', ['-c', 'echo change > g.txt'], { cwd: dir })
    git('add', '-A')
    git('commit', '-q', '-m', 'work done on feature branch')
    git('checkout', '-q', 'main')
    const headAfter = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim()

    expect(headAfter).toBe(headBefore)

    const result = await computeCommittedDuringRun(dir, headBefore, headAfter, startedAt, new Date().toISOString())
    expect(result).toBe(true)
  })

  it('no commit anywhere in the window → false (fix must not blanket-suppress the real detector)', async () => {
    const { dir, git } = initRepo()
    commitInPast(dir, git, 'f.txt', 'base')
    const headBefore = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim()
    const startedAt = new Date().toISOString()

    // No further commits anywhere.
    const headAfter = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim()

    const result = await computeCommittedDuringRun(dir, headBefore, headAfter, startedAt, new Date().toISOString())
    expect(result).toBe(false)
  })
})
