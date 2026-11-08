import { describe, expect, it, vi } from 'vitest'
import {
  inspectPluginDir,
  listPluginMcpServers,
  readPluginManifest,
  resolvePluginComponents,
  summarizePluginContents,
} from '../pluginContents'

const ROOT = '/home/u/.claude/plugins/cache/mkt/demo/1.0.0'

/** A plugin dir held in memory behind a stub `window.api.config`: file path → text; directories are implied. */
function stubConfigApi(files: Record<string, string>) {
  const isDir = (p: string) => Object.keys(files).some((f) => f.startsWith(`${p}/`))
  const exists = vi.fn(async (p: string) => p in files || isDir(p))
  const readJson = vi.fn(async (p: string) => {
    if (!(p in files)) return { exists: false, parseError: false, data: null, mtimeMs: 0, error: null }
    return { exists: true, parseError: false, data: JSON.parse(files[p]) as unknown, mtimeMs: 0, error: null }
  })
  const readText = vi.fn(async (p: string) =>
    p in files ? { exists: true, text: files[p], mtimeMs: 0, error: null } : { exists: false, text: '', mtimeMs: 0, error: null },
  )
  const listDir = vi.fn(async (dir: string, opts: { filesOnly?: boolean; dirsOnly?: boolean } = {}) => {
    const children = new Map<string, boolean>()
    for (const f of Object.keys(files)) {
      if (!f.startsWith(`${dir}/`)) continue
      const rest = f.slice(dir.length + 1)
      const slash = rest.indexOf('/')
      children.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0)
    }
    const entries = [...children]
      .filter(([, d]) => (opts.filesOnly ? !d : opts.dirsOnly ? d : true))
      .map(([name, d]) => ({ name, path: `${dir}/${name}`, isDirectory: d, isFile: !d, mtimeMs: 0, size: 0 }))
    return { ok: true, error: null, entries }
  })
  ;(globalThis as unknown as { window: unknown }).window = { api: { config: { exists, readJson, readText, listDir } } }
  return { listDir }
}

const json = (v: unknown) => JSON.stringify(v)

describe('pluginContents', () => {
  it('summarizes a plugin dir with the Plugins table counts and lists its .mcp.json server', async () => {
    stubConfigApi({
      [`${ROOT}/.claude-plugin/plugin.json`]: json({ name: 'demo', version: '1.0.0' }),
      [`${ROOT}/skills/alpha/SKILL.md`]: '---\nname: alpha\ndescription: First.\n---\nA\n',
      [`${ROOT}/skills/beta/SKILL.md`]: '---\nname: beta\ndescription: Second.\n---\nB\n',
      [`${ROOT}/commands/deploy.md`]: '---\ndescription: Ship it.\n---\n',
      [`${ROOT}/commands/notes.txt`]: 'not a command',
      [`${ROOT}/agents/reviewer.md`]: '---\nname: reviewer\ndescription: Reviews.\n---\n',
      [`${ROOT}/hooks/hooks.json`]: json({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'c' }] }],
        },
      }),
      [`${ROOT}/.mcp.json`]: json({ mcpServers: { db: { command: 'npx', args: ['db-mcp'] } } }),
    })

    const row = await inspectPluginDir({ name: 'demo', path: ROOT, isDirectory: true, isFile: false, mtimeMs: 0, size: 0 })

    expect(summarizePluginContents(row)).toEqual({ skills: 2, commands: 1, agents: 1, hooks: 3, mcpServers: 1 })
    expect(row.hasMcp).toBe(true)
    expect(await listPluginMcpServers(ROOT)).toEqual([{ id: 'db', name: 'db', description: 'npx' }])
  })

  it.each([
    ['a declared path', './config/servers.json'],
    ['an inline object', { api: { url: 'https://api.example.com/mcp' } }],
  ])('lists servers from %s exactly as resolvePluginComponents does, without listing component dirs', async (_, decl) => {
    const { listDir } = stubConfigApi({
      [`${ROOT}/.claude-plugin/plugin.json`]: json({ name: 'demo', mcpServers: decl }),
      [`${ROOT}/config/servers.json`]: json({ api: { url: 'https://api.example.com/mcp' } }),
      [`${ROOT}/.mcp.json`]: json({ mcpServers: { api: { command: 'shadowed' }, db: { command: 'npx' } } }),
    })

    const servers = await listPluginMcpServers(ROOT)

    expect(servers).toEqual([
      { id: 'api', name: 'api', description: 'https://api.example.com/mcp' },
      { id: 'db', name: 'db', description: 'npx' },
    ])
    expect(listDir).not.toHaveBeenCalled()
    const { manifest } = await readPluginManifest(ROOT)
    expect((await resolvePluginComponents(ROOT, manifest)).mcpServers).toEqual(servers)
  })
})
