// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'
import type { ConfigChangedEvent } from '../../../../preload/api'

/**
 * Plugins.tsx had no watch at all — its installed-plugins table was built
 * from a one-shot readJson at mount. This proves it now watches
 * ~/.claude/plugins/installed_plugins.json via the generic
 * window.api.config.watch/config:changed mechanism and re-reads the row list
 * on an external change (e.g. `claude plugin install` run outside this app).
 */

const HOME = '/home/test'
const MANIFEST_PATH = `${HOME}/.claude/plugins/installed_plugins.json`

const ONE_PLUGIN = {
  version: 1,
  plugins: {
    'alpha@marketplace-a': [
      { scope: 'user', installPath: `${HOME}/.claude/plugins/alpha`, version: '1.0.0', installedAt: '', lastUpdated: '' },
    ],
  },
}

const TWO_PLUGINS = {
  version: 1,
  plugins: {
    ...ONE_PLUGIN.plugins,
    'beta@marketplace-a': [
      { scope: 'user', installPath: `${HOME}/.claude/plugins/beta`, version: '1.0.0', installedAt: '', lastUpdated: '' },
    ],
  },
}

function installWindowApiMock() {
  const configChangedHandlers: Array<(e: ConfigChangedEvent) => void> = []
  let manifest: typeof ONE_PLUGIN = ONE_PLUGIN

  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      exists: vi.fn().mockResolvedValue(false),
      readJson: vi.fn(async (path: string) => {
        if (path === MANIFEST_PATH) {
          return { exists: true, parseError: false, data: manifest, mtimeMs: 0, error: null }
        }
        return { exists: false, parseError: false, data: null, mtimeMs: 0, error: null }
      }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn((handler: (e: ConfigChangedEvent) => void) => {
        configChangedHandlers.push(handler)
        return () => {
          const i = configChangedHandlers.indexOf(handler)
          if (i >= 0) configChangedHandlers.splice(i, 1)
        }
      }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return {
    api,
    addBetaPlugin: () => { manifest = TWO_PLUGINS },
    emitConfigChanged: (path: string) =>
      configChangedHandlers.forEach((h) => h({ path, mtimeMs: Date.now(), kind: 'change' })),
  }
}

const flush = () => flushAsync(4)

describe('Plugins watches installed_plugins.json via config:changed', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('registers a watch on installed_plugins.json on mount', async () => {
    const { api } = installWindowApiMock()
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => { root.render(createElement(Plugins)) })
    await flush()

    const watchedPaths = api.config.watch.mock.calls.flatMap((c) => c[0] as string[])
    expect(watchedPaths).toContain(MANIFEST_PATH)
    act(() => root.unmount())
  })

  it('re-reads rows when config:changed fires for the watched manifest file', async () => {
    const { addBetaPlugin, emitConfigChanged } = installWindowApiMock()
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => { root.render(createElement(Plugins)) })
    await flush()

    expect(container.textContent).toContain('alpha')
    expect(container.textContent).not.toContain('beta')

    addBetaPlugin()
    await act(async () => {
      emitConfigChanged(MANIFEST_PATH)
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).toContain('beta')
    act(() => root.unmount())
  })

  it('unwatches the manifest file on unmount', async () => {
    const { api } = installWindowApiMock()
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => { root.render(createElement(Plugins)) })
    await flush()

    act(() => root.unmount())
    const unwatchedPaths = api.config.unwatch.mock.calls.flatMap((c) => c[0] as string[])
    expect(unwatchedPaths).toContain(MANIFEST_PATH)
  })
})
