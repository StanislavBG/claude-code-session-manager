import { describe, expect, it } from 'vitest'
import type { MdDoc } from '../../../preload/api'
import { STALE_DAYS, docFlags, relativeAge, usageLine } from '../mdCurate'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 13)

function doc(p: Partial<MdDoc> & { path: string }): MdDoc {
  return {
    role: 'doc', depth: 1, lines: 10, bytes: 100, lastCommitMs: NOW - DAY, commits: 1, linkedFrom: 1,
    codeRefs: 0, codeRefFiles: [], deadRefs: [], ambiguousRefs: [], changedSince: [], collection: null, ...p,
  }
}

describe('constants', () => {
  it('STALE_DAYS is 90', () => {
    expect(STALE_DAYS).toBe(90)
  })
})

describe('usageLine', () => {
  it('returns the per-role phrases', () => {
    expect(usageLine(doc({ path: 'CLAUDE.md', role: 'map', depth: 0 }))).toBe('Entry map: loaded into every session')
    expect(usageLine(doc({ path: 'docs/x.md', role: 'map' }))).toBe('Imported by CLAUDE.md: loaded into every session')
    expect(usageLine(doc({ path: 'src/renderer/CLAUDE.md', role: 'scoped' }))).toBe('Loaded when an agent works in src/renderer/')
    expect(usageLine(doc({ path: 'AGENTS.md', role: 'scoped' }))).toBe('Loaded when an agent works in the project root')
    expect(usageLine(doc({ path: '.claude/agents/a.md', role: 'agent' }))).toBe('Loaded by name as a skill, agent, command or rule')
    expect(usageLine(doc({ path: 'v/r1.md', role: 'record', collection: 'v/' }))).toBe('Machine-written record in v/')
    expect(usageLine(doc({ path: 'a.md', depth: 2 }))).toBe('Reachable from CLAUDE.md in 2 link(s)')
    expect(usageLine(doc({ path: 'a.md', depth: null }))).toBe('Nothing links here from CLAUDE.md')
  })
  it('appends the code-file count, singular for 1', () => {
    expect(usageLine(doc({ path: 'a.md', depth: null, codeRefs: 1 }))).toBe('Nothing links here from CLAUDE.md · named by 1 code file')
    expect(usageLine(doc({ path: 'a.md', depth: 1, codeRefs: 3 }))).toBe('Reachable from CLAUDE.md in 1 link(s) · named by 3 code files')
  })
})

describe('docFlags', () => {
  it('returns every flag in order', () => {
    const d = doc({
      path: 'a.md', depth: null, lastCommitMs: NOW - 100 * DAY, deadRefs: ['x', 'y'],
      changedSince: [{ path: 'src/a.ts', ms: NOW - 5 * DAY }, { path: 'src/b.ts', ms: NOW - 50 * DAY }],
    })
    expect(docFlags(d, null, NOW)).toEqual([
      { flag: 'stale', label: 'no change in 90+ days' },
      { flag: 'changed', label: '2 named file(s) changed since' },
      { flag: 'missing-refs', label: '2 missing path(s)' },
      { flag: 'unlinked', label: 'unlinked' },
    ])
  })
  it('a recent review clears stale and counts only changes after it', () => {
    const d = doc({
      path: 'a.md', lastCommitMs: NOW - 100 * DAY,
      changedSince: [{ path: 'src/a.ts', ms: NOW - 5 * DAY }, { path: 'src/b.ts', ms: NOW - 50 * DAY }],
    })
    expect(docFlags(d, NOW - 10 * DAY, NOW)).toEqual([{ flag: 'changed', label: '1 named file(s) changed since' }])
    expect(docFlags(d, NOW - 200 * DAY, NOW).map((f) => f.flag)).toEqual(['stale', 'changed'])
  })
  it('null lastCommitMs is stale with its own label', () => {
    expect(docFlags(doc({ path: 'a.md', lastCommitMs: null }), null, NOW))
      .toEqual([{ flag: 'stale', label: 'no change in the scanned history' }])
  })
  it('a fresh linked doc has no flags', () => {
    expect(docFlags(doc({ path: 'a.md' }), null, NOW)).toEqual([])
  })
  it('records get no flags', () => {
    const d = doc({ path: 'v/r.md', role: 'record', depth: null, lastCommitMs: null, deadRefs: ['x'], changedSince: [{ path: 'a', ms: NOW }] })
    expect(docFlags(d, null, NOW)).toEqual([])
  })
})

describe('relativeAge', () => {
  it('formats ages', () => {
    expect(relativeAge(null, NOW)).toBe('before the scanned history')
    expect(relativeAge(NOW - 1000, NOW)).toBe('today')
    expect(relativeAge(NOW + DAY, NOW)).toBe('today')
    expect(relativeAge(NOW - 3 * DAY, NOW)).toBe('3d ago')
    expect(relativeAge(NOW - 35 * DAY, NOW)).toBe('5w ago')
    expect(relativeAge(NOW - 215 * DAY, NOW)).toBe('7mo ago')
    expect(relativeAge(NOW - 800 * DAY, NOW)).toBe('2y ago')
  })
})
