import { beforeEach, describe, expect, it, vi } from 'vitest'

const err = vi.fn()
const warn = vi.fn()
vi.mock('../../state/toast', () => ({ toast: { error: (m: string) => err(m), warn: (m: string) => warn(m), info: vi.fn() } }))

import { listMarketplacePlugins } from '../pluginMarketplaces'

type Files = Record<string, unknown | { parseError: string }>

function mockConfig(files: Files) {
  const readJson = vi.fn(async (path: string) => {
    if (!(path in files)) return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }
    const v = files[path] as { parseError?: string }
    if (v && typeof v === 'object' && 'parseError' in v)
      return { exists: true, raw: '', data: null, parseError: v.parseError, mtimeMs: 0, error: null }
    return { exists: true, raw: '', data: v, parseError: null, mtimeMs: 0, error: null }
  })
  ;(globalThis as unknown as { window: unknown }).window = { api: { config: { readJson } } }
}

const R = '/h/.claude/plugins'

describe('listMarketplacePlugins', () => {
  beforeEach(() => {
    err.mockClear()
    warn.mockClear()
  })

  it('lists every plugin in every known marketplace, incl. bundled session-manager', async () => {
    mockConfig({
      [`${R}/known_marketplaces.json`]: { 'session-manager': {}, official: { installLocation: '/custom/official' } },
      [`${R}/marketplaces/session-manager/.claude-plugin/marketplace.json`]: {
        plugins: [{ name: 'session-manager-dev', description: 'dev', source: './plugins/session-manager-dev' }],
      },
      '/custom/official/.claude-plugin/marketplace.json': {
        plugins: [{ name: 'a', description: 'A', source: { source: 'url', url: 'https://x/y.git' } }, { name: 'b' }],
      },
    })
    const r = await listMarketplacePlugins('/h')
    expect(r).toEqual([
      { marketplace: 'session-manager', name: 'session-manager-dev', description: 'dev', source: './plugins/session-manager-dev' },
      { marketplace: 'official', name: 'a', description: 'A', source: 'https://x/y.git' },
      { marketplace: 'official', name: 'b', description: '', source: '' },
    ])
    expect(err).not.toHaveBeenCalled()
  })

  it('skips missing and invalid files with a toast, never throws', async () => {
    mockConfig({
      [`${R}/known_marketplaces.json`]: { gone: {}, bad: {}, ok: {} },
      [`${R}/marketplaces/bad/.claude-plugin/marketplace.json`]: { parseError: 'Unexpected token' },
      [`${R}/marketplaces/ok/.claude-plugin/marketplace.json`]: { plugins: [{ name: 'p' }] },
    })
    const r = await listMarketplacePlugins('/h')
    expect(r.map((p) => p.name)).toEqual(['p'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('returns [] and toasts when known_marketplaces.json is invalid; [] silently when absent', async () => {
    mockConfig({ [`${R}/known_marketplaces.json`]: { parseError: 'boom' } })
    expect(await listMarketplacePlugins('/h')).toEqual([])
    expect(err).toHaveBeenCalledTimes(1)
    mockConfig({})
    expect(await listMarketplacePlugins('/h')).toEqual([])
    expect(err).toHaveBeenCalledTimes(1)
  })
})
