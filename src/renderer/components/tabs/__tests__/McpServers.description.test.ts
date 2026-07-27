// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The MCP servers sidebar should surface each server's user-set `description`
 * (when present) as a muted line under the name, and show the name alone
 * with no broken layout when a server has none. The editor form should
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
  const writeJson = vi.fn(async (path: string, data: unknown) => {
    if (path === CLAUDE_JSON_PATH) raw = JSON.stringify(data, null, 2) + '\n'
    return { ok: true, mtimeMs: 0 }
  })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/test') },
    mcp: { status: vi.fn().mockResolvedValue({ ok: true, servers: [] }) },
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
      writeJson,
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

function flush() {
  return act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

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

  it('shows the description under the name when present, and just the name when absent', async () => {
    installWindowApiMock()
    const { McpServers } = await import('../McpServers')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(McpServers))
    })
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('Talks to the widget API.')

    const rows = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('no-desc'),
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].textContent).not.toContain('Talks to the widget API.')

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

    const saveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save')
    if (saveButton) {
      act(() => {
        saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await flush()
    }

    expect(api.config.writeJson).toHaveBeenCalled()
    expect(getRaw()).toContain('A freshly-added description.')

    act(() => root.unmount())
  })
})
