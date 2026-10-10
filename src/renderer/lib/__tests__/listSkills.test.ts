import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listSkillEntries } from '../listSkills'

type Tree = Record<string, string[]>
type Files = Record<string, string>

function mockConfig(tree: Tree, files: Files, failList: string[] = []) {
  const listDir = vi.fn(async (path: string) => {
    if (failList.includes(path)) return { ok: false, entries: [], error: 'EACCES' }
    return {
      ok: true,
      entries: (tree[path] ?? []).map((name) => ({ name, path: `${path}/${name}` })),
    }
  })
  const readText = vi.fn(async (path: string) =>
    path in files ? { exists: true, text: files[path] } : { exists: false, text: '' },
  )
  ;(globalThis as unknown as { window: unknown }).window = { api: { config: { listDir, readText } } }
}

describe('listSkillEntries', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists a flat skill', async () => {
    mockConfig({ '/s': ['a'] }, { '/s/a/SKILL.md': 'A' })
    const r = await listSkillEntries('/s')
    expect(r.errors).toEqual([])
    expect(r.entries).toEqual([{ name: 'a', path: '/s/a/SKILL.md', dir: '/s/a', text: 'A' }])
  })

  it('finds a namespaced skill only when nested is on', async () => {
    const tree = { '/s': ['ns'], '/s/ns': ['b'] }
    const files = { '/s/ns/b/SKILL.md': 'B' }
    mockConfig(tree, files)
    expect((await listSkillEntries('/s', { nested: true })).entries.map((e) => e.name)).toEqual(['b'])
    expect((await listSkillEntries('/s')).entries.map((e) => e.name)).toEqual(['b'])
    expect((await listSkillEntries('/s', { nested: false })).entries).toEqual([])
  })

  it('skips a folder without SKILL.md', async () => {
    mockConfig({ '/s': ['empty'] }, {})
    const r = await listSkillEntries('/s')
    expect(r.entries).toEqual([])
    expect(r.errors).toEqual([])
  })

  it('reports a listDir error in errors', async () => {
    mockConfig({}, {}, ['/s'])
    const r = await listSkillEntries('/s')
    expect(r.entries).toEqual([])
    expect(r.errors).toEqual([{ path: '/s', error: 'EACCES' }])
  })
})
