// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SystemPrompt } from '../SystemPrompt'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useConfig } from '../../../state/config'

/**
 * SystemPrompt's scope switcher defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> 'user', Project face ->
 * 'project' (falling back to 'user' if no active-tab cwd resolves). Mirrors
 * HistoryDashboard.navface.test.tsx's auto-default-unless-manually-touched
 * coverage.
 */

// MarkdownEditor wraps @monaco-editor/react, which doesn't render in jsdom.
vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'markdown-editor' }),
}))

// ReferencedFilesPanel calls config:parse-imports on mount; stub it out so
// this test can focus on scope-defaulting without wiring that IPC too.
vi.mock('../ReferencedFilesPanel', () => ({
  ReferencedFilesPanel: () => createElement('div', { 'data-testid': 'referenced-files' }),
}))

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
      readText: vi.fn().mockResolvedValue({ text: '', exists: false, mtimeMs: 0, error: null }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
      parseImports: vi.fn().mockResolvedValue([]),
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
    root!.render(createElement(SystemPrompt))
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
  useLayout.setState({ focusedPanelId: 'overview' })
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

describe('SystemPrompt NavFace-driven default scope', () => {
  it('mounts at navFace=home with scope defaulted to user', async () => {
    const el = await mount()
    expect(activeScope(el)).toBe('User')
  })

  it('flipping navFace to project (with an active tab cwd) defaults scope to project', async () => {
    const el = await mount()
    expect(activeScope(el)).toBe('User')
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ focusedPanelId: 'terminal' })
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('Project')
  })

  it('flipping navFace to project with no active-tab cwd stays on user', async () => {
    const el = await mount()
    await act(async () => {
      useLayout.setState({ focusedPanelId: 'terminal' })
      await Promise.resolve()
    })
    expect(activeScope(el)).toBe('User')
  })

  it('a manual scope change survives a re-render at the same navFace', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ focusedPanelId: 'terminal' })
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
})
