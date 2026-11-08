// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { ConfigChangedEvent, DirEntry, InstalledPlugin, ListDirResult } from '../../../preload/api'
import { useExtensionCounts, type ExtensionCounts } from '../useExtensionCounts'

const HOME = '/home/u'
const SKILLS = `${HOME}/.claude/skills`
const COMMANDS = `${HOME}/.claude/commands`
const CLAUDE_JSON = `${HOME}/.claude.json`
const MANIFEST = `${HOME}/.claude/plugins/installed_plugins.json`

const file = (dir: string, name: string): DirEntry => ({
  name, path: `${dir}/${name}`, isDirectory: false, isFile: true, mtimeMs: 0, size: 0,
})
const folder = (dir: string, name: string): DirEntry => ({ ...file(dir, name), isDirectory: true, isFile: false })
const servers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`srv-${i}`, { command: 'npx' }]))
const plugins = (n: number): InstalledPlugin[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `p${i}@mkt`, name: `p${i}`, marketplace: 'mkt', version: null, scope: 'user',
    // Plugin dirs carry their own skills/commands — the hook must never walk them.
    installPath: `${HOME}/.claude/plugins/cache/mkt/p${i}`, enabled: true,
  }))

// What the stub window.api serves; a test edits it before mounting or firing a change.
let dirs: Record<string, DirEntry[]>
let skillFiles: Record<string, string>
let mcpServers: Record<string, unknown>
let installed: InstalledPlugin[]
const handlers = new Set<(info: ConfigChangedEvent) => void>()

function makeApi() {
  return {
    app: { homeDir: vi.fn(async () => HOME) },
    config: {
      listDir: vi.fn(async (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }): Promise<ListDirResult> => ({
        ok: true,
        entries: (dirs[path] ?? []).filter((e) => (opts?.filesOnly ? e.isFile : opts?.dirsOnly ? e.isDirectory : true)),
        error: null,
      })),
      readText: vi.fn(async (path: string) =>
        path in skillFiles ? { exists: true, text: skillFiles[path] } : { exists: false, text: '' }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn((h: (info: ConfigChangedEvent) => void) => {
        handlers.add(h)
        return () => { handlers.delete(h) }
      }),
    },
    claudeConfig: { read: vi.fn(async () => ({ path: CLAUDE_JSON, data: { mcpServers } as Record<string, unknown> })) },
    plugins: { list: vi.fn(async () => installed) },
  }
}
let api: ReturnType<typeof makeApi>

let root: Root | null = null
let seen: ExtensionCounts
function Probe() {
  seen = useExtensionCounts()
  return null
}
// Several macrotask turns so every chained read (home → listDir → readText) lands inside act.
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
const render = async () => {
  root = createRoot(document.createElement('div'))
  await act(async () => { root!.render(createElement(Probe)) })
}
const mount = async () => {
  await render()
  await settle()
}
const unmount = () => {
  act(() => root?.unmount())
  root = null
}
const fire = async (path: string) => {
  await act(async () => { for (const h of [...handlers]) h({ path, mtimeMs: 1, kind: 'change' }) })
  await settle()
}

beforeEach(() => {
  // 0 skills + 1 command (a non-.md file is not a command); 7 servers; 2 plugins.
  dirs = { [SKILLS]: [], [COMMANDS]: [file(COMMANDS, 'deploy.md'), file(COMMANDS, 'notes.txt')] }
  skillFiles = {}
  mcpServers = servers(7)
  installed = plugins(2)
  handlers.clear()
  api = makeApi()
  ;(globalThis as any).window.api = api
})
afterEach(() => {
  if (root) unmount()
})

describe('useExtensionCounts', () => {
  it('is all null while the reads are in flight', async () => {
    api.config.listDir.mockReturnValue(new Promise(() => {}))
    api.claudeConfig.read.mockReturnValue(new Promise(() => {}))
    api.plugins.list.mockReturnValue(new Promise(() => {}))
    await mount()
    expect(seen).toEqual({ skills: null, mcp: null, plugins: null })
  })

  it('counts user skills + .md commands, user MCP servers and installed plugins', async () => {
    await mount()
    expect(seen).toEqual({ skills: 1, mcp: 7, plugins: 2 })
    expect(api.config.listDir).toHaveBeenCalledWith(COMMANDS, { filesOnly: true })
    expect(api.claudeConfig.read).toHaveBeenCalledWith({ fileId: 'claudeJson', scope: 'user' })
    // Plugin-provided skills/commands are not counted: only the two user roots are listed.
    expect(new Set(api.config.listDir.mock.calls.map(([p]) => p))).toEqual(new Set([SKILLS, COMMANDS]))
  })

  it.each([
    { source: 'skills listDir', breakIt: () => api.config.listDir.mockRejectedValue(new Error('EIO')), expected: { skills: null, mcp: 7, plugins: 2 } },
    {
      source: 'commands listDir (ok:false)',
      breakIt: () => api.config.listDir.mockImplementation(async (p: string) =>
        p === COMMANDS ? { ok: false, entries: [], error: 'EACCES' } : { ok: true, entries: [], error: null }),
      expected: { skills: null, mcp: 7, plugins: 2 },
    },
    { source: 'claudeConfig.read', breakIt: () => api.claudeConfig.read.mockRejectedValue(new Error('bad JSON')), expected: { skills: 1, mcp: null, plugins: 2 } },
    { source: 'plugins.list', breakIt: () => api.plugins.list.mockRejectedValue(new Error('ipc down')), expected: { skills: 1, mcp: 7, plugins: null } },
  ])('a failed $source read nulls only that count', async ({ breakIt, expected }) => {
    breakIt()
    await mount()
    expect(seen).toEqual(expected)
  })

  it('re-counts only the source whose watched path changed', async () => {
    await mount()
    const mcpReads = api.claudeConfig.read.mock.calls.length
    const listings = api.config.listDir.mock.calls.length

    installed = plugins(3)
    await fire(MANIFEST)
    expect(seen).toEqual({ skills: 1, mcp: 7, plugins: 3 })
    expect(api.claudeConfig.read.mock.calls.length).toBe(mcpReads)
    expect(api.config.listDir.mock.calls.length).toBe(listings)

    mcpServers = servers(4)
    await fire(CLAUDE_JSON)
    expect(seen.mcp).toBe(4)

    dirs[SKILLS] = [folder(SKILLS, 'alpha')]
    skillFiles[`${SKILLS}/alpha/SKILL.md`] = '---\nname: alpha\n---\n'
    await fire(SKILLS)
    expect(seen.skills).toBe(2)

    dirs[COMMANDS] = [...dirs[COMMANDS], file(COMMANDS, 'review.md')]
    await fire(COMMANDS)
    expect(seen).toEqual({ skills: 3, mcp: 4, plugins: 3 })
  })

  it('ignores a change to a path no count reads', async () => {
    await mount()
    const reads = () =>
      api.config.listDir.mock.calls.length + api.claudeConfig.read.mock.calls.length + api.plugins.list.mock.calls.length
    const before = reads()
    await fire(`${HOME}/.claude/settings.json`)
    expect(reads()).toBe(before)
  })

  it('drops a stale response that resolves after a newer one', async () => {
    await mount()
    let resolveSlow: (v: InstalledPlugin[]) => void = () => {}
    api.plugins.list
      .mockImplementationOnce(() => new Promise<InstalledPlugin[]>((r) => { resolveSlow = r }))
      .mockImplementationOnce(async () => plugins(5))
    await fire(MANIFEST) // slow re-count in flight
    await fire(MANIFEST) // newer re-count lands first
    expect(seen.plugins).toBe(5)
    await act(async () => { resolveSlow(plugins(9)) })
    await settle()
    expect(seen.plugins).toBe(5)
  })

  it('watches the counted paths and removes its config.onChanged listeners on unmount', async () => {
    await mount()
    const watched = api.config.watch.mock.calls.flatMap(([paths]) => paths as string[])
    expect(new Set(watched)).toEqual(new Set([SKILLS, COMMANDS, CLAUDE_JSON, MANIFEST]))
    expect(handlers.size).toBeGreaterThan(0)
    unmount()
    expect(handlers.size).toBe(0)
    expect(new Set(api.config.unwatch.mock.calls.flatMap(([paths]) => paths as string[]))).toEqual(new Set(watched))
  })
})
