// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { McpServers } from '../McpServers'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useConfig } from '../../../state/config'

/**
 * McpServers's scope switcher defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> 'user', Project face ->
 * 'project' (falling back to 'user' if no active-tab cwd resolves). Mirrors
 * Skills.navface.test.tsx's auto-default-unless-manually-touched coverage.
 */

const HOME = '/home/bilko'
const PROJECT_CWD = '/home/bilko/Projects/alpha'

const PROJECT_TAB: SessionTab = {
  id: 'tab-alpha',
  sessionId: 'tab-alpha',
  label: 'alpha',
  cwd: PROJECT_CWD,
  pid: null,
  status: 'dormant',
  exitCode: null,
  startupCommand: null,
  presetId: null,
  generation: 0,
}

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      readText: vi.fn().mockResolvedValue({ text: '', exists: false, mtimeMs: 0, error: null }),
      readJson: vi.fn().mockResolvedValue({
        raw: '',
        data: null,
        exists: false,
        mtimeMs: 0,
        parseError: null,
        error: null,
      }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    files: {
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
    mcp: {
      status: vi.fn().mockResolvedValue({ ok: true, error: null, servers: [] }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(McpServers))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

const SCOPE_LABELS = ['User', 'Project', 'Local']

function activeScope(el: HTMLElement): string | null {
  const btn = Array.from(el.querySelectorAll('button')).find(
    (b) => SCOPE_LABELS.includes(b.textContent?.trim() ?? '') && b.classList.contains('bg-bg-hi'),
  )
  return btn?.textContent?.trim() ?? null
}

function clickScope(el: HTMLElement, label: string) {
  const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  ;(btn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  installWindowApiMock()
  useLayout.setState({ navFace: 'home' })
  useSessions.setState({ tabs: [], activeTabId: null })
  useConfig.setState({ files: {}, watchRefs: {} })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
})

describe('McpServers NavFace-driven default scope', () => {
  it('mounts at navFace=home with scope defaulted to user', async () => {
    const el = await mount()
    expect(activeScope(el)).toBe('User')
  })

  it('flipping navFace to project (with an active tab cwd) defaults scope to project', async () => {
    const el = await mount()
    expect(activeScope(el)).toBe('User')
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('Project')
  })

  it('flipping navFace to project with no active-tab cwd stays on user', async () => {
    const el = await mount()
    await act(async () => {
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('User')
  })

  it('a manual scope change survives a re-render at the same navFace', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('Project')

    await act(async () => {
      clickScope(el, 'User')
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('User')

    // A re-render at the SAME navFace ('project') must not reset the manual choice.
    await act(async () => {
      useSessions.setState({ tabs: [{ ...PROJECT_TAB }], activeTabId: PROJECT_TAB.id })
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('User')
  })

  // McpServers is now HOME-only in the sidebar (navGroups.ts, PRD 963), but a
  // project tab can still be active while browsing the Home nav list — this
  // proves the face move didn't remove access to Project-scope editing.
  it('navFace stays home with an active project tab: Project scope is offered and resolves to that tab\'s cwd', async () => {
    const el = await mount()
    const api = window.api as unknown as { config: { readJson: ReturnType<typeof vi.fn> } }
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      await Promise.resolve()
    })
    expect(useLayout.getState().navFace).toBe('home')
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(
      expect.arrayContaining(['Project']),
    )

    await act(async () => {
      clickScope(el, 'Project')
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('Project')
    // The scope resolved to the active tab's cwd, not just a UI toggle:
    // useScopedConfigFiles loaded the project-scope settings.json for it.
    expect(
      api.config.readJson.mock.calls.some((call) => String(call[0]).startsWith(PROJECT_CWD)),
    ).toBe(true)
  })
})
