// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * A server's user-set `description` rides on its 3a list row as the tooltip —
 * line 2 stays "<origin> · <status>" — and a server without one has no
 * tooltip. The editor form (behind the 3a detail's Edit JSON) should
 * round-trip a description edit back into the saved config.
 */

const CLAUDE_JSON_PATH = '/home/test/.claude.json'

const CONFIG = {
  mcpServers: {
    'with-desc': {
      type: 'stdio',
      command: 'npx',
      args: ['with-desc-server'],
      description: 'Talks to the widget API.',
    },
    'no-desc': {
      type: 'stdio',
      command: 'npx',
      args: ['no-desc-server'],
    },
  },
}

function installWindowApiMock() {
  let raw = JSON.stringify(CONFIG, null, 2) + '\n'
  const patch = vi.fn(async (p: { keyPath: string[]; value?: unknown }) => {
    const next = JSON.parse(raw) as Record<string, unknown>
    let cur = next
    for (const k of p.keyPath.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
    cur[p.keyPath[p.keyPath.length - 1]] = p.value
    raw = JSON.stringify(next, null, 2) + '\n'
    return { ok: true, path: CLAUDE_JSON_PATH, data: next }
  })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/test') },
    mcp: { status: vi.fn().mockResolvedValue({ ok: true, servers: [] }) },
    claudeConfig: {
      read: vi.fn(async () => ({ path: CLAUDE_JSON_PATH, data: JSON.parse(raw) })),
      patch,
    },
    config: {
      readJson: vi.fn(async (path: string) => {
        if (path === CLAUDE_JSON_PATH) {
          return { exists: true, parseError: false, data: JSON.parse(raw), mtimeMs: 0, error: null, raw }
        }
        return { exists: false, parseError: false, data: null, mtimeMs: 0, error: null, raw: '' }
      }),
      readText: vi.fn(async (path: string) => {
        if (path === CLAUDE_JSON_PATH) return { exists: true, raw, mtimeMs: 0, error: null }
        return { exists: false, raw: '', mtimeMs: 0, error: null }
      }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, getRaw: () => raw }
}

const flush = () => flushAsync(4)

describe('McpServers sidebar + editor description', () => {
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

  it('carries the description as the row tooltip, not as row text, and leaves it off a server without one', async () => {
    installWindowApiMock()
    const { McpServers } = await import('../McpServers')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(McpServers))
    })
    await flush()

    const row = (name: string) => container.querySelector<HTMLElement>(`[data-testid="mcp-row-${name}"]`)
    expect(row('with-desc')?.getAttribute('title')).toBe('Talks to the widget API.')
    expect(row('with-desc')?.textContent).not.toContain('Talks to the widget API.')
    expect(container.querySelector('[data-testid="mcp-status-with-desc"]')?.textContent).toMatch(/ · not checked$/)

    expect(row('no-desc')).not.toBeNull()
    expect(row('no-desc')!.hasAttribute('title')).toBe(false)
    expect(row('no-desc')!.textContent).not.toContain('Talks to the widget API.')

    act(() => root.unmount())
  })

  it('round-trips a description edit from the editor into the saved config', async () => {
    const { api, getRaw } = installWindowApiMock()
    const { McpServers } = await import('../McpServers')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(McpServers))
    })
    await flush()

    const noDescButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('no-desc'),
    )
    expect(noDescButton).toBeTruthy()
    act(() => {
      noDescButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    // The per-server form lives behind the 3a detail's Edit JSON.
    const editJson = container.querySelector<HTMLButtonElement>('[data-testid="mcp-edit-json"]')
    expect(editJson).toBeTruthy()
    act(() => {
      editJson!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    const descInput = Array.from(container.querySelectorAll('input')).find(
      (i) => i.previousElementSibling?.textContent === 'description' || i.placeholder === 'what this server does…',
    )
    expect(descInput).toBeTruthy()

    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      nativeSetter.call(descInput, 'A freshly-added description.')
      descInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    // The SaveBar's Save carries its shortcut hint after the label ("Save" + "Ctrl S").
    const saveButton = Array.from(container.querySelectorAll('button')).find((b) => /^Save(Ctrl S|⌘S)?$/.test(b.textContent ?? ''))
    if (saveButton) {
      act(() => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
    }

    expect(api.claudeConfig.patch).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPath: ['mcpServers', 'no-desc'],
        value: expect.objectContaining({ description: 'A freshly-added description.' }),
      }),
    )
    expect(getRaw()).toContain('A freshly-added description.')

    act(() => root.unmount())
  })
})
