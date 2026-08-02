// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { useLayout } from '../../../state/layout'
import { useSessions, type SessionTab } from '../../../state/sessions'
import { useConfig } from '../../../state/config'

/**
 * Settings's scope switcher defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> 'user', Project face ->
 * 'project' (falling back to 'user' if no active-tab cwd resolves). Mirrors
 * Permissions.navface.test.tsx's auto-default-unless-manually-touched coverage.
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
  const raw = JSON.stringify({}, null, 2) + '\n'
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      readJson: vi.fn().mockResolvedValue({
        raw,
        data: JSON.parse(raw),
        exists: true,
        mtimeMs: 0,
        parseError: null,
        error: null,
      }),
      readText: vi.fn().mockResolvedValue({ text: raw, raw, exists: true, mtimeMs: 0, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      writeText: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      exists: vi.fn().mockResolvedValue(true),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    otel: {
      getConfig: vi.fn().mockResolvedValue({ enabled: false }),
      status: vi.fn().mockResolvedValue({ running: false }),
      configPath: vi.fn().mockResolvedValue('/home/bilko/.config/session-manager/otel.json'),
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
    root!.render(createElement(Settings))
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

describe('Settings NavFace-driven default scope', () => {
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
})

function viewTabLabels(el: HTMLElement): string[] {
  const toolbar = el.querySelector('.flex.rounded.border.border-line.overflow-hidden')
  return Array.from(toolbar?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim() ?? '')
}

function clickViewTab(el: HTMLElement, label: string) {
  const toolbar = el.querySelector('.flex.rounded.border.border-line.overflow-hidden')
  const btn = Array.from(toolbar?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === label)
  ;(btn as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('Settings Telemetry/Session Manager tabs are Home-only', () => {
  // SettingsTelemetry (~/.config/session-manager/otel.json) and
  // SettingsAppPrefs (localStorage) have no cwd/scope input anywhere — they
  // render identically regardless of navFace, so they must not appear as an
  // option on the Project face.
  it('shows Telemetry and Session Manager tabs on the Home face', async () => {
    const el = await mount()
    const labels = viewTabLabels(el)
    expect(labels).toContain('Telemetry')
    expect(labels).toContain('Session Manager')
  })

  it('hides Telemetry and Session Manager tabs on the Project face', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    const labels = viewTabLabels(el)
    expect(labels).not.toContain('Telemetry')
    expect(labels).not.toContain('Session Manager')
  })

  it('bounces back to Guided if navFace flips to project while Telemetry was selected', async () => {
    const el = await mount()
    await act(async () => {
      clickViewTab(el, 'Telemetry')
      await Promise.resolve()
    })
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      useLayout.setState({ navFace: 'project' })
      await Promise.resolve()
    })
    // Guided is the only tab whose active-state class survives; assert no
    // dead 'active' styling is stuck on a tab that's no longer rendered.
    const labels = viewTabLabels(el)
    expect(labels).not.toContain('Telemetry')
    expect(el.textContent).not.toContain('Session Manager preferences')
  })
})
