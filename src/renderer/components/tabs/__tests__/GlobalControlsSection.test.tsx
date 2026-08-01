// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GlobalControlsSection } from '../GlobalControlsSection'
import { useConfig } from '../../../state/config'

const HOME = '/home/bilko'
const SETTINGS_PATH = `${HOME}/.claude/settings.json`
const MCP_PATH = `${HOME}/.claude.json`
const CLAUDE_MD_PATH = `${HOME}/.claude/CLAUDE.md`

const SETTINGS_DATA = {
  theme: 'dark',
  permissions: { allow: ['Bash(git *)'], deny: [], ask: ['WebFetch'] },
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] }],
  },
}

const MCP_DATA = {
  mcpServers: {
    fetch: { command: 'fetch-server' },
    playwright: { command: 'playwright-server' },
  },
}

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn(async (path: string) => {
        if (path === SETTINGS_PATH) {
          return { exists: true, raw: JSON.stringify(SETTINGS_DATA), data: SETTINGS_DATA, parseError: null, mtimeMs: 1, error: null }
        }
        if (path === MCP_PATH) {
          return { exists: true, raw: JSON.stringify(MCP_DATA), data: MCP_DATA, parseError: null, mtimeMs: 1, error: null }
        }
        return { exists: false, raw: '', data: null, parseError: null, mtimeMs: 0, error: null }
      }),
      readText: vi.fn(async (path: string) => {
        if (path === CLAUDE_MD_PATH) {
          return { exists: true, text: '# hello world', mtimeMs: 1, error: null }
        }
        return { exists: false, text: '', mtimeMs: 0, error: null }
      }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount(navigate?: (k: string) => void) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(GlobalControlsSection, { navigate: navigate as never }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  installWindowApiMock()
  useConfig.setState({ files: {}, watchRefs: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('GlobalControlsSection', () => {
  it('renders a card per dual-scope tab with a count/status summary from mocked config', async () => {
    const el = await mount()
    const text = el.textContent ?? ''
    expect(text).toContain('Settings')
    expect(text).toContain('3 top-level keys configured')
    expect(text).toContain('Permissions')
    expect(text).toContain('2 rule(s) configured')
    expect(text).toContain('Hooks')
    expect(text).toContain('3 hook(s) configured')
    expect(text).toContain('MCP Servers')
    expect(text).toContain('2 MCP server(s)')
    expect(text).toContain('System Prompt')
    expect(text).toContain('configured (13 chars)')
    expect(text).toContain('Skills')
    expect(text).toContain('0 skill(s) installed')
  })

  it('clicking a card calls navigate with the corresponding NavKey', async () => {
    const navigate = vi.fn()
    const el = await mount(navigate)
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('MCP Servers'))
    ;(btn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(navigate).toHaveBeenCalledWith('mcp')
  })
})
