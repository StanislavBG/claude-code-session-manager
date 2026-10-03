// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Skills } from '../Skills'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { HOME, PROJECT_CWD, PROJECT_TAB, useNavfaceHarness, activeScope, clickScope } from './_navfaceHarness'

/**
 * Skills's scope switcher defaults from the NavFace
 * (leftnav-two-face-framework): Home face -> 'user', Project face ->
 * 'project' (falling back to 'user' if no active-tab cwd resolves). Mirrors
 * SystemPrompt.navface.test.tsx's auto-default-unless-manually-touched
 * coverage.
 */

// MarkdownEditor wraps @monaco-editor/react, which doesn't render in jsdom.
vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'markdown-editor' }),
}))

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn().mockResolvedValue({ ok: true, error: null, entries: [] }),
      readText: vi.fn().mockResolvedValue({ text: '', exists: false, mtimeMs: 0, error: null }),
      writeText: vi.fn().mockResolvedValue({ ok: true }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    files: {
      delete: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const { mount } = useNavfaceHarness(Skills, installWindowApiMock)

describe('Skills NavFace-driven default scope', () => {
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

  // Skills is now HOME-only in the sidebar (navGroups.ts, PRD 963), but a
  // project tab can still be active while browsing the Home nav list — this
  // proves the face move didn't remove access to Project-scope editing.
  it('navFace stays home with an active project tab: Project scope is offered and resolves to that tab\'s cwd', async () => {
    const el = await mount()
    const api = window.api as unknown as { config: { listDir: ReturnType<typeof vi.fn> } }
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
    // `roots(home, cwd)` listed the project-scope skills/commands dirs for it.
    expect(
      api.config.listDir.mock.calls.some((call) => String(call[0]).startsWith(PROJECT_CWD)),
    ).toBe(true)
  })
})
