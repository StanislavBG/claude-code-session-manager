import { describe, it, expect } from 'vitest'
import {
  searchConfig,
  loadConfigSearchItems,
  type ConfigSearchApi,
  type ConfigSearchItem,
} from '../configSearch'
import { SETTINGS_GROUPS } from '../settingsGroups'

const item = (tab: ConfigSearchItem['tab'], title: string, extra: Partial<ConfigSearchItem> = {}): ConfigSearchItem => ({
  tab,
  id: `${tab}:${title}`,
  title,
  ...extra,
})

describe('searchConfig', () => {
  it('returns [] for a blank query', () => {
    const items = [item('mcp', 'github')]
    expect(searchConfig(items, '')).toEqual([])
    expect(searchConfig(items, '   \t ')).toEqual([])
  })

  it('ranks exact title > title prefix > title substring > detail/keyword match, case-insensitively', () => {
    const items = [
      item('skills', 'Notes', { detail: 'about the git workflow' }),
      item('skills', 'my-git-helper'),
      item('skills', 'Gitignore tools'),
      item('skills', 'misc', { keywords: ['GIT'] }),
      item('skills', 'GIT'),
    ]
    const [group] = searchConfig(items, 'git')
    expect(group.tab).toBe('skills')
    expect(group.items.map((i) => i.title)).toEqual(['GIT', 'Gitignore tools', 'my-git-helper', 'Notes', 'misc'])
    expect(group.total).toBe(5)
  })

  it('requires every whitespace-separated term to match title, detail or keywords', () => {
    const items = [
      item('mcp', 'github', { detail: 'stdio server' }),
      item('mcp', 'gitlab', { detail: 'http server' }),
      item('mcp', 'sqlite', { keywords: ['stdio'] }),
    ]
    const [group] = searchConfig(items, '  GIT   stdio ')
    expect(group.items.map((i) => i.title)).toEqual(['github'])
    expect(searchConfig(items, 'git nothing-matches')).toEqual([])
  })

  it('caps each tab at limitPerTab and reports the full total', () => {
    const items = Array.from({ length: 8 }, (_, i) => item('settings', `model-${i}`))
    const [group] = searchConfig(items, 'model')
    expect(group.items).toHaveLength(5)
    expect(group.total).toBe(8)
    const [two] = searchConfig(items, 'model', 2)
    expect(two.items.map((i) => i.title)).toEqual(['model-0', 'model-1'])
    expect(two.total).toBe(8)
  })

  it('groups in tab order and omits tabs with no match', () => {
    const items = [
      item('agents', 'x-agent'),
      item('mcp', 'x-mcp'),
      item('memory', 'x-memory'),
      item('plugins', 'x-plugin'),
      item('claude-md', 'x-claude'),
      item('skills', 'unrelated'),
      item('settings', 'x-setting'),
    ]
    expect(searchConfig(items, 'x-').map((g) => g.tab)).toEqual([
      'memory',
      'claude-md',
      'settings',
      'mcp',
      'plugins',
      'agents',
    ])
  })
})

/** A fake window.api over an in-memory file map. */
function fakeApi(over: { failPlugins?: boolean } = {}): ConfigSearchApi & { calls: string[] } {
  const calls: string[] = []
  const files: Record<string, string> = {
    '/home/u/.claude/skills/review/SKILL.md': '---\nname: review\ndescription: Review a diff\n---\nbody',
    '/home/u/.claude/skills/ns/inner/SKILL.md': '---\ndescription: Nested skill\n---\n',
    '/proj/.claude/skills/deploy/SKILL.md': '---\ndescription: Ship it\n---\n',
  }
  const dirs: Record<string, { name: string; path: string }[]> = {
    '/home/u/.claude/skills': [
      { name: 'review', path: '/home/u/.claude/skills/review' },
      { name: 'ns', path: '/home/u/.claude/skills/ns' },
    ],
    '/home/u/.claude/skills/ns': [{ name: 'inner', path: '/home/u/.claude/skills/ns/inner' }],
    '/home/u/.claude/commands': [
      { name: 'standup.md', path: '/home/u/.claude/commands/standup.md' },
      { name: 'notes.txt', path: '/home/u/.claude/commands/notes.txt' },
    ],
    '/proj/.claude/skills': [{ name: 'deploy', path: '/proj/.claude/skills/deploy' }],
    '/proj/.claude/commands': [],
  }
  const json: Record<string, unknown> = {
    '/home/u/.claude/settings.json': { model: 'opus', myCustomKey: 1 },
    '/proj/.claude/settings.json': { projectOnlyKey: true },
    '/proj/.mcp.json': { mcpServers: { 'proj-db': { command: 'db' } } },
  }
  const readJson = (path: string) => {
    calls.push(`readJson ${path}`)
    const data = json[path]
    return Promise.resolve({ exists: data !== undefined, raw: '', data: data ?? null, parseError: null, mtimeMs: 0, error: null })
  }
  return {
    calls,
    app: { homeDir: () => Promise.resolve('/home/u') },
    config: {
      exists: (p: string) => Promise.resolve(p.endsWith('/CLAUDE.md') || p.endsWith('/CLAUDE.local.md')),
      readJson,
      readText: (p: string) =>
        Promise.resolve(p in files ? { exists: true, text: files[p] } : { exists: false, text: '' }) as never,
      listDir: (p: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }) =>
        Promise.resolve({
          ok: true,
          error: null,
          entries: (dirs[p] ?? [])
            .map((e) => ({ ...e, isDirectory: !e.name.includes('.'), isFile: e.name.includes('.'), mtimeMs: 0, size: 0 }))
            .filter((e) => (opts?.dirsOnly ? e.isDirectory : opts?.filesOnly ? e.isFile : true)),
        }),
      parseImports: (p: string) =>
        Promise.resolve(
          p === '/home/u/.claude/CLAUDE.md'
            ? { ok: true as const, imports: [{ path: '/home/u/shared/core.md', exists: true, sizeBytes: 1, tokenEstimate: 1, ok: true }] }
            : { ok: true as const, imports: [] },
        ),
    },
    claudeConfig: {
      read: () => Promise.resolve({ path: '/home/u/.claude.json', data: { mcpServers: { github: {}, sqlite: {} } } }),
    },
    memory: {
      list: () =>
        Promise.resolve({
          entries: [{ name: 'feedback_tests.md', path: '/mem/feedback_tests.md', mtimeMs: 0, bytes: 1 }],
          workspace: 'w',
          dir: '/mem',
          autoMemoryEnabled: true,
          error: null,
        }),
    },
    plugins: {
      list: () =>
        over.failPlugins
          ? Promise.reject(new Error('plugins boom'))
          : Promise.resolve([
              { key: 'stripe@official', name: 'stripe', marketplace: 'official', version: '1', scope: 'user', installPath: null, enabled: true },
            ]),
    },
    agents: {
      listPersonas: () => Promise.resolve([{ name: 'dev-lead', description: 'Executes one PRD' }] as never),
    },
  }
}

const byTab = (items: ConfigSearchItem[], tab: ConfigSearchItem['tab']) => items.filter((i) => i.tab === tab).map((i) => i.title)

describe('loadConfigSearchItems', () => {
  it('lists every Home config item through the injected api', async () => {
    const items = await loadConfigSearchItems({ scope: 'home', cwd: null, api: fakeApi() })
    expect(byTab(items, 'claude-md')).toEqual(['CLAUDE.md', 'core.md'])
    expect(byTab(items, 'mcp')).toEqual(['github', 'sqlite'])
    expect(byTab(items, 'skills')).toEqual(['review', 'inner', 'standup'])
    expect(items.find((i) => i.title === 'review')?.detail).toBe('Review a diff')
    expect(byTab(items, 'plugins')).toEqual(['stripe'])
    expect(byTab(items, 'agents')).toEqual(['dev-lead'])
    expect(byTab(items, 'memory')).toEqual([])
    const settings = byTab(items, 'settings')
    for (const key of SETTINGS_GROUPS.flatMap((g) => g.keys)) expect(settings).toContain(key)
    expect(settings).toContain('myCustomKey')
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
  })

  it('lists Project items (memory, project files) and no plugins/agents', async () => {
    const items = await loadConfigSearchItems({ scope: 'project', cwd: '/proj', api: fakeApi() })
    expect(byTab(items, 'memory')).toEqual(['feedback_tests.md'])
    expect(byTab(items, 'claude-md')).toEqual(['CLAUDE.md', 'CLAUDE.local.md'])
    expect(byTab(items, 'mcp')).toEqual(['proj-db'])
    expect(byTab(items, 'skills')).toEqual(['deploy'])
    expect(byTab(items, 'settings')).toContain('projectOnlyKey')
    expect(byTab(items, 'plugins')).toEqual([])
    expect(byTab(items, 'agents')).toEqual([])
  })

  it('drops only the failing reader’s items when one reader throws', async () => {
    const items = await loadConfigSearchItems({ scope: 'home', cwd: null, api: fakeApi({ failPlugins: true }) })
    expect(byTab(items, 'plugins')).toEqual([])
    expect(byTab(items, 'agents')).toEqual(['dev-lead'])
    expect(byTab(items, 'mcp')).toEqual(['github', 'sqlite'])
    expect(byTab(items, 'skills')).toEqual(['review', 'inner', 'standup'])
    expect(searchConfig(items, 'dev').map((g) => g.tab)).toContain('agents')
  })
})
