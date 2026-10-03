// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Hooks } from '../Hooks'
import { Permissions } from '../Permissions'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { HOME, PROJECT_CWD, PROJECT_TAB, useNavfaceHarness, activeScope, clickScope, viewTabLabels, clickViewTab } from './_navfaceHarness'

/**
 * Hooks and Permissions share one NavFace shape: the scope switcher defaults
 * from the NavFace (Home face -> 'user', Project face -> 'project', falling
 * back to 'user' if no active-tab cwd resolves), and one static reference tab
 * (Hooks "Library", Permissions "Presets") is Home-only. Mirrors
 * McpServers.navface.test.tsx's auto-default-unless-manually-touched coverage.
 */

function makeInstaller(rootKey: string) {
  return function installWindowApiMock() {
    const raw = JSON.stringify({ [rootKey]: {} }, null, 2) + '\n'
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
    }
    ;(window as unknown as { api: typeof api }).api = api
    return api
  }
}

describe.each([
  { name: 'Hooks', Component: Hooks, rootKey: 'hooks', homeOnlyTab: 'Library' },
  { name: 'Permissions', Component: Permissions, rootKey: 'permissions', homeOnlyTab: 'Presets' },
])('$name navface', ({ name, Component, rootKey, homeOnlyTab }) => {
  const { mount } = useNavfaceHarness(Component, makeInstaller(rootKey))

  describe(`${name} NavFace-driven default scope`, () => {
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

    // {name} is now HOME-only in the sidebar (navGroups.ts, PRD 963), but a
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

  describe(`${name} ${homeOnlyTab} tab is Home-only`, () => {
    // HooksLibrary is a static reference catalog with no cwd/scope input —
    // identical regardless of navFace, so it must not appear as an option on
    // the Project face.
    it(`shows the ${homeOnlyTab} tab on the Home face`, async () => {
      const el = await mount()
      expect(viewTabLabels(el)).toContain(homeOnlyTab)
    })

    it(`hides the ${homeOnlyTab} tab on the Project face`, async () => {
      const el = await mount()
      await act(async () => {
        useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
        useLayout.setState({ navFace: 'project' })
        await Promise.resolve()
      })
      expect(viewTabLabels(el)).not.toContain(homeOnlyTab)
    })

    it(`bounces back to Effective if navFace flips to project while ${homeOnlyTab} was selected`, async () => {
      const el = await mount()
      await act(async () => {
        clickViewTab(el, homeOnlyTab)
        await Promise.resolve()
      })
      await act(async () => {
        useSessions.setState({ tabs: [PROJECT_TAB], activeTabId: PROJECT_TAB.id })
        useLayout.setState({ navFace: 'project' })
        await Promise.resolve()
      })
      expect(viewTabLabels(el)).not.toContain(homeOnlyTab)
    })
  })
})
