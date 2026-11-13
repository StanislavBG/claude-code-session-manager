import { describe, expect, it } from 'vitest'
import type { MdCensus, MdDoc } from '../../../preload/api'
import {
  EMPTY_CURATION, STALE_DAYS, composeCurationBrief, docFlags, normalizeCuration, relativeAge, usageLine,
  type MdCuration,
} from '../mdCurate'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 13)

function doc(p: Partial<MdDoc> & { path: string }): MdDoc {
  return {
    role: 'doc', depth: 1, lines: 10, bytes: 100, lastCommitMs: NOW - DAY, commits: 1, linkedFrom: 1,
    codeRefs: 0, codeRefFiles: [], deadRefs: [], changedSince: [], collection: null, ...p,
  }
}

function census(docs: MdDoc[]): MdCensus {
  return {
    docs, collections: [],
    counts: { tracked: docs.length, network: docs.length, records: 0, unlinked: 0, byRole: { map: 0, scoped: 0, agent: 0, record: 0, doc: 0 } },
    gitWindow: { commits: 1, oldestMs: null }, warnings: [],
  }
}

function cur(p: Partial<MdCuration>): MdCuration {
  return { ...EMPTY_CURATION, ...p }
}

describe('constants', () => {
  it('STALE_DAYS is 90 and EMPTY_CURATION is empty', () => {
    expect(STALE_DAYS).toBe(90)
    expect(EMPTY_CURATION).toEqual({ verdicts: {}, notes: {}, reviewedAt: {}, recordFolders: [], docFolders: [] })
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

describe('normalizeCuration', () => {
  it('never throws on junk', () => {
    for (const raw of [null, undefined, 1, 'x', [], { verdicts: 5 }, { verdicts: [1], notes: null }]) {
      expect(normalizeCuration(raw)).toEqual(EMPTY_CURATION)
    }
  })
  it('drops malformed entries and keeps good ones', () => {
    const c = normalizeCuration({
      verdicts: { 'a.md': 'keep', 'b.md': 'nope', 'c.md': 3, '': 'keep' },
      notes: { 'a.md': 'hi', 'b.md': 7 },
      reviewedAt: { 'a.md': 5, 'b.md': 'x', 'c.md': Number.NaN },
      recordFolders: ['v/', 3, '', 'v/'],
      docFolders: 'nope',
    })
    expect(c).toEqual({ verdicts: { 'a.md': 'keep' }, notes: { 'a.md': 'hi' }, reviewedAt: { 'a.md': 5 }, recordFolders: ['v/'], docFolders: [] })
  })
  it('caps sizes', () => {
    const verdicts: Record<string, string> = {}
    const reviewedAt: Record<string, number> = {}
    for (let i = 0; i < 2500; i++) { verdicts[`d${i}.md`] = 'delete'; reviewedAt[`d${i}.md`] = i }
    const folders = Array.from({ length: 80 }, (_, i) => `f${i}/`)
    const c = normalizeCuration({ verdicts, reviewedAt, notes: { 'a.md': 'x'.repeat(500) }, recordFolders: folders, docFolders: folders })
    expect(Object.keys(c.verdicts)).toHaveLength(2000)
    expect(Object.keys(c.reviewedAt)).toHaveLength(2000)
    expect(c.notes['a.md']).toHaveLength(280)
    expect(c.recordFolders).toHaveLength(50)
    expect(c.docFolders).toHaveLength(50)
  })
})

describe('composeCurationBrief', () => {
  const docs = census([doc({ path: 'a.md' }), doc({ path: 'b.md' }), doc({ path: 'c.md' })])

  it('whole project when nothing is picked; ignores verdicts on unknown paths', () => {
    const r = composeCurationBrief(cur({ verdicts: { 'gone.md': 'delete' } }), docs)
    expect(r.picked).toBe(0)
    expect(r.scope).toBe('the whole project')
    expect(r.extraInstructions).toBe('')
  })

  it('lists picked docs in scope and follows the template', () => {
    const r = composeCurationBrief(cur({
      verdicts: { 'a.md': 'keep', 'b.md': 'delete', 'c.md': 'delete', 'gone.md': 'merge' },
      notes: { 'b.md': 'obsolete' },
      recordFolders: ['v/'],
      docFolders: ['docs/'],
    }), docs)
    expect(r.picked).toBe(3)
    expect(r.scope).toBe('these docs: a.md, b.md, c.md')
    expect(r.extraInstructions).toBe([
      'Human curation from the Project Home MD network explorer. Treat each verdict as the human\'s decision: verify it against the code, then plan the changes.',
      'KEEP: a.md',
      'DELETE: b.md (note: obsolete), c.md',
      'Record folders (machine-written; keep them out of the map): v/',
      'Count as docs, not records: docs/',
    ].join('\n'))
  })

  it('folder-only curation still writes instructions', () => {
    const r = composeCurationBrief(cur({ recordFolders: ['v/'] }), docs)
    expect(r.scope).toBe('the whole project')
    expect(r.extraInstructions).toContain('Record folders (machine-written; keep them out of the map): v/')
  })

  it('more than 8 picked, or a scope over 600 chars, points at the instructions', () => {
    const many = census(Array.from({ length: 9 }, (_, i) => doc({ path: `d${i}.md` })))
    const verdicts = Object.fromEntries(many.docs.map((d) => [d.path, 'update' as const]))
    expect(composeCurationBrief(cur({ verdicts }), many).scope).toBe('the 9 docs listed in the additional instructions')
    const long = census([doc({ path: `${'x'.repeat(400)}.md` }), doc({ path: `${'y'.repeat(400)}.md` })])
    const lv = Object.fromEntries(long.docs.map((d) => [d.path, 'keep' as const]))
    expect(composeCurationBrief(cur({ verdicts: lv }), long).scope).toBe('the 2 docs listed in the additional instructions')
  })

  it('caps extraInstructions at 4000 chars with a trailer', () => {
    const big = census(Array.from({ length: 500 }, (_, i) => doc({ path: `docs/some/long/folder/name/file-${i}.md` })))
    const verdicts = Object.fromEntries(big.docs.map((d) => [d.path, 'delete' as const]))
    const r = composeCurationBrief(cur({ verdicts }), big)
    expect(r.picked).toBe(500)
    expect(r.extraInstructions.length).toBeLessThanOrEqual(4000)
    const m = /… and (\d+) more not listed$/.exec(r.extraInstructions)
    expect(m).not.toBeNull()
    const listed = (r.extraInstructions.match(/file-\d+\.md/g) ?? []).length
    expect(listed + Number(m![1])).toBe(500)
  })
})
