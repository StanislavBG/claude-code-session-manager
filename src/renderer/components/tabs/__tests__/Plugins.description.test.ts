// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Installed-plugins table rows should surface each plugin manifest's
 * `description` (when present) as a muted line under the name, and show the
 * name alone with no broken layout when a manifest has none.
 */

const INSTALLED_MANIFEST = {
  version: 1,
  plugins: {
    'with-desc@marketplace-a': [
      {
        scope: 'user',
        installPath: '/home/test/.claude/plugins/with-desc',
        version: '1.0.0',
        installedAt: '',
        lastUpdated: '',
      },
    ],
    'no-desc@marketplace-a': [
      {
        scope: 'user',
        installPath: '/home/test/.claude/plugins/no-desc',
        version: '1.0.0',
        installedAt: '',
        lastUpdated: '',
      },
    ],
  },
}

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/test') },
    config: {
      exists: vi.fn(async (path: string) => {
        return (
          path === '/home/test/.claude/plugins/with-desc/.claude-plugin/plugin.json' ||
          path === '/home/test/.claude/plugins/no-desc/.claude-plugin/plugin.json'
        )
      }),
      readJson: vi.fn(async (path: string) => {
        if (path === '/home/test/.claude/plugins/installed_plugins.json') {
          return { exists: true, parseError: false, data: INSTALLED_MANIFEST, mtimeMs: 0, error: null }
        }
        if (path === '/home/test/.claude/plugins/with-desc/.claude-plugin/plugin.json') {
          return {
            exists: true,
            parseError: false,
            data: { name: 'with-desc', version: '1.0.0', description: 'Does the one thing well.' },
            mtimeMs: 0,
            error: null,
          }
        }
        if (path === '/home/test/.claude/plugins/no-desc/.claude-plugin/plugin.json') {
          return { exists: true, parseError: false, data: { name: 'no-desc', version: '1.0.0' }, mtimeMs: 0, error: null }
        }
        return { exists: false, parseError: false, data: null, mtimeMs: 0, error: null }
      }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

function flush() {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Plugins installed table description', () => {
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

  it('shows the manifest description under the name when present, and just the name when absent', async () => {
    installWindowApiMock()
    const { Plugins } = await import('../Plugins')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('Does the one thing well.')

    const rows = Array.from(container.querySelectorAll('tr[data-row-key]'))
    const noDescRow = rows.find((r) => r.textContent?.includes('no-desc'))
    expect(noDescRow).toBeTruthy()
    const nameCell = noDescRow?.querySelector('td')
    expect(nameCell?.textContent).toBe('no-desc')

    // Description subtitle must be bounded so `truncate` can actually clip it —
    // the surrounding <table> uses auto layout, so only a `width`/`max-width`
    // on the cell content itself (not the <th>) constrains long text.
    const withDescRow = rows.find((r) => r.textContent?.includes('with-desc'))
    const descDiv = withDescRow?.querySelector('td div.truncate.text-fg-faint') as HTMLElement | undefined
    expect(descDiv).toBeTruthy()
    expect(descDiv?.getAttribute('title')).toBe('Does the one thing well.')
    const wrapper = descDiv?.parentElement as HTMLElement | undefined
    expect(wrapper?.style.maxWidth).toBeTruthy()

    act(() => root.unmount())
  })
})
