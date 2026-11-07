// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Settings } from '../Settings'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { HOME, PROJECT_CWD, PROJECT_TAB, useNavfaceHarness, activeScope, clickScope, viewTabLabels, clickViewTab } from './_navfaceHarness'

/**
 * Settings's scope switcher defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> 'user', Project face ->
 * 'project' (falling back to 'user' if no active-tab cwd resolves). Mirrors
 * Permissions.navface.test.tsx's auto-default-unless-manually-touched coverage.
 */

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
      configPath: vi.fn().mockResolvedValue('/home/bilko/.claude/session-manager/otel.json'),
    },
    telemetry: {
      getConfig: vi.fn().mockResolvedValue({ enabled: false, installId: 'install-uuid', endpoint: '' }),
      setConfig: vi.fn().mockResolvedValue({ ok: true, config: { enabled: false } }),
      status: vi.fn().mockResolvedValue({ pendingCount: 0, sentCount: 0, dedupedAppends: 0, evictedCount: 0 }),
      configPath: vi.fn().mockResolvedValue('/home/bilko/.claude/session-manager/telemetry.json'),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const { mount } = useNavfaceHarness(Settings, installWindowApiMock)

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

  // Settings is now HOME-only in the sidebar (navGroups.ts, PRD 963), but a
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

describe('Settings scope note states which real file is being edited', () => {
  // Settings is substrate, not per-session curation (CLAUDE.md): each scope is
  // a direct view of the on-disk file the claude CLI reads on every session it
  // launches. That has to be visible on screen, not just a switcher tooltip.
  const note = (el: HTMLElement) => el.querySelector('[data-testid="settings-scope-note"]')?.textContent ?? ''

  it('names the global file and its machine-wide reach at user scope', async () => {
    const el = await mount()
    expect(activeScope(el)).toBe('User')
    expect(note(el)).toContain('Global settings')
    expect(note(el)).toContain('~/.claude/settings.json')
    expect(note(el)).toContain('every project and every session')
    // The resolved absolute path, not just the ~ shorthand.
    expect(note(el)).toContain(`${HOME}/.claude/settings.json`)
  })

  it('switches to the project file and its per-project reach at project scope', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      await Promise.resolve()
    })
    await act(async () => {
      clickScope(el, 'Project')
      await Promise.resolve()
    })
    expect(note(el)).toContain('Project settings')
    expect(note(el)).toContain('checked into git')
    expect(note(el)).toContain(`${PROJECT_CWD}/.claude/settings.json`)
    expect(note(el)).not.toContain('Global settings')
  })

  it('marks local scope as gitignored and this-machine-only', async () => {
    const el = await mount()
    await act(async () => {
      useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
      await Promise.resolve()
    })
    await act(async () => {
      clickScope(el, 'Local')
      await Promise.resolve()
    })
    expect(note(el)).toContain('Local settings')
    expect(note(el)).toContain('gitignored')
    expect(note(el)).toContain(`${PROJECT_CWD}/.claude/settings.local.json`)
  })
})

describe('Settings has no Session Manager app views (moved to AppSettings)', () => {
  it('offers no Telemetry, Phone remote or Session Manager tab on either face', async () => {
    const el = await mount()
    const labels = viewTabLabels(el)
    for (const l of ['Telemetry', 'Phone remote', 'Session Manager']) expect(labels).not.toContain(l)
  })
})
