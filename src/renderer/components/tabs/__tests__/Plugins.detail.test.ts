// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

// Monaco doesn't mount in jsdom; render the raw value so tests can assert on
// the skill body text, mirroring Skills.description.test.ts's approach.
vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: ({ value }: { value: string }) => createElement('pre', null, value),
}))

/**
 * Selecting an installed plugin's row shows its PluginDetail beside the list: eyebrow + name header,
 * the manifest description, what it adds (real skill/agent/command/MCP data) and where it is installed.
 * The detail re-reads its components live; a skill row opens the read-only SkillHomePage in its place.
 */

const HOME = '/home/test'
const PLUGIN_PATH = `${HOME}/.claude/plugins/demo`
const NO_MANIFEST_PATH = `${HOME}/.claude/plugins/bare`

const INSTALLED_MANIFEST = {
  version: 1,
  plugins: {
    'demo@marketplace-a': [
      { scope: 'user', installPath: PLUGIN_PATH, version: '1.2.3', installedAt: '', lastUpdated: '' },
    ],
    'bare@marketplace-a': [
      { scope: 'user', installPath: NO_MANIFEST_PATH, version: '0.0.1', installedAt: '', lastUpdated: '' },
    ],
  },
}

const DEMO_MANIFEST = {
  name: 'demo',
  version: '1.2.3',
  description: 'Does the one thing well and describes it in one long sentence that should truncate.',
  author: { name: 'Ada Author' },
  license: 'MIT',
  homepage: 'https://example.com/demo',
}

const SKILL_MD = `---\nname: my-skill\ndescription: Does the skill thing. More detail here.\n---\nBody text.\n`
const AGENT_MD = `---\nname: my-agent\ndescription: Reviews things carefully.\n---\nAgent body.\n`

function installWindowApiMock() {
  const agentFiles: Record<string, string> = { 'my-agent.md': AGENT_MD }
  const changedHandlers: Array<(e: { path: string; mtimeMs: number; kind: 'change' }) => void> = []
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      exists: vi.fn(async (path: string) => {
        return (
          path === `${PLUGIN_PATH}/.claude-plugin/plugin.json` ||
          path === `${PLUGIN_PATH}/agents` ||
          path === `${PLUGIN_PATH}/skills`
        )
      }),
      readJson: vi.fn(async (path: string) => {
        if (path === `${HOME}/.claude/plugins/installed_plugins.json`) {
          return { exists: true, parseError: false, data: INSTALLED_MANIFEST, mtimeMs: 0, error: null }
        }
        if (path === `${PLUGIN_PATH}/.claude-plugin/plugin.json`) {
          return { exists: true, parseError: false, data: DEMO_MANIFEST, mtimeMs: 0, error: null }
        }
        return { exists: false, parseError: false, data: null, mtimeMs: 0, error: null }
      }),
      readText: vi.fn(async (path: string) => {
        if (path === `${PLUGIN_PATH}/skills/my-skill/SKILL.md`) {
          return { exists: true, text: SKILL_MD, mtimeMs: 0, error: null }
        }
        const agentName = path.startsWith(`${PLUGIN_PATH}/agents/`) ? path.slice(`${PLUGIN_PATH}/agents/`.length) : null
        if (agentName && agentFiles[agentName] !== undefined) {
          return { exists: true, text: agentFiles[agentName], mtimeMs: 0, error: null }
        }
        return { exists: false, text: '', mtimeMs: 0, error: null }
      }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      listDir: vi.fn(async (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }) => {
        if (path === `${PLUGIN_PATH}/skills` && opts?.dirsOnly) {
          return {
            ok: true,
            error: null,
            entries: [
              {
                name: 'my-skill',
                path: `${PLUGIN_PATH}/skills/my-skill`,
                isDirectory: true,
                isFile: false,
                mtimeMs: 0,
                size: 0,
              },
            ],
          }
        }
        if (path === `${PLUGIN_PATH}/agents` && opts?.filesOnly) {
          return {
            ok: true,
            error: null,
            entries: Object.keys(agentFiles).map((name) => ({
              name,
              path: `${PLUGIN_PATH}/agents/${name}`,
              isDirectory: false,
              isFile: true,
              mtimeMs: 0,
              size: 0,
            })),
          }
        }
        return { ok: true, error: null, entries: [] }
      }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn((h: (e: { path: string; mtimeMs: number; kind: 'change' }) => void) => {
        changedHandlers.push(h)
        return () => {}
      }),
    },
    plugins: {
      list: vi.fn(async () =>
        Object.entries(INSTALLED_MANIFEST.plugins).map(([key, [e]]) => ({
          key,
          name: key.split('@')[0],
          marketplace: key.split('@')[1],
          version: e.version,
          scope: e.scope,
          installPath: e.installPath,
          enabled: true,
        })),
      ),
      setEnabled: vi.fn().mockResolvedValue({ ok: true }),
      uninstall: vi.fn().mockResolvedValue({ ok: true, exitCode: 0 }),
    },
    shell: {
      open: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  const fireChange = () =>
    changedHandlers.forEach((h) => h({ path: `${HOME}/.claude/plugins/installed_plugins.json`, mtimeMs: 1, kind: 'change' }))
  const fireAt = (path: string) =>
    changedHandlers.forEach((h) => h({ path, mtimeMs: 1, kind: 'change' }))
  return Object.assign(api, { fireChange, fireAt, agentFiles })
}

const flush = () => flushAsync(5)

describe('Plugins detail', () => {
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

  const cards = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="config-list-row"]'))
  /** The list row whose mono title reads `name`. */
  const cardFor = (name: string) => cards().find((c) => c.querySelector('.font-mono')?.textContent === name) as HTMLElement
  /** Clicking a row selects it and shows its detail. */
  const openCard = (card: HTMLElement) => card.click()
  const detailText = () => container.querySelector('[data-testid="config-workbench-detail"]')?.textContent ?? ''

  it('shows the selected plugin in the detail: header, description, what it adds, install path', async () => {
    const api = installWindowApiMock()
    const { Plugins } = await import('../Plugins')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    // Rows sort by name, so `bare` (no manifest) is selected first.
    expect(cardFor('bare').getAttribute('aria-selected')).toBe('true')
    expect(cardFor('demo').textContent).toContain('marketplace-a · 1 skill · 1 agent')

    act(() => {
      openCard(cardFor('demo'))
    })
    await flush()

    expect(cardFor('demo').getAttribute('aria-selected')).toBe('true')
    const text = detailText()
    expect(text).toContain('PLUGIN · MARKETPLACE-A · V1.2.3 · USER SCOPE')
    expect(text).toContain('demo')
    expect(text).toContain(DEMO_MANIFEST.description)
    expect(text).toContain('WHAT IT ADDS · 1 SKILL · 1 AGENT')
    expect(text).toContain('my-skill')
    expect(text).toContain('Does the skill thing.')
    expect(text).toContain('my-agent')
    expect(text).toContain('Reviews things carefully.')
    expect(text).toContain('~/.claude/plugins/demo')

    expect(api.config.readJson).toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('re-lists and shows a newly installed plugin when installed_plugins.json changes', async () => {
    const api = installWindowApiMock()
    const { Plugins } = await import('../Plugins')
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()
    expect(container.textContent).not.toContain('fresh')

    const plugins = INSTALLED_MANIFEST.plugins as Record<string, unknown>
    plugins['fresh@marketplace-a'] = [
      { scope: 'user', installPath: `${HOME}/.claude/plugins/fresh`, version: '9.9.9', installedAt: '', lastUpdated: '' },
    ]
    try {
      act(() => api.fireChange())
      await flush()
      expect(cardFor('fresh')).toBeTruthy()
    } finally {
      delete plugins['fresh@marketplace-a']
    }
    act(() => root.unmount())
  })

  it('navigates to a full-page Skill Home on skill row click, and back returns to the Skills section', async () => {
    installWindowApiMock()
    const { Plugins } = await import('../Plugins')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    act(() => {
      openCard(cardFor('demo'))
    })
    await flush()

    const skillRow = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('my-skill'),
    ) as HTMLButtonElement
    expect(skillRow).toBeTruthy()

    act(() => {
      skillRow.click()
    })
    await flush()

    // The detail is replaced by the full-page Skill Home.
    const text = container.textContent ?? ''
    expect(text).toContain('my-skill')
    expect(text).toContain('demo')
    expect(text).toContain('Body text.')

    const skillBackLink = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim().startsWith('←') && b.textContent?.includes('demo'),
    ) as HTMLButtonElement
    expect(skillBackLink).toBeTruthy()

    act(() => {
      skillBackLink.click()
    })
    await flush()

    // Back to the plugin's detail, with the list still beside it.
    expect(cards().length).toBe(2)
    const afterBackText = container.textContent ?? ''
    expect(afterBackText).toContain('my-skill')
    expect(afterBackText).toContain('Does the skill thing.')
    expect(afterBackText).not.toContain('Body text.')

    act(() => root.unmount())
  })

  it('handles a plugin with no manifest: shows directory name, path and a no-manifest note, no crash', async () => {
    installWindowApiMock()
    const { Plugins } = await import('../Plugins')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    const bareRow = cardFor('bare')
    expect(bareRow).toBeTruthy()

    act(() => {
      openCard(bareRow)
    })
    await flush()

    const text = detailText()
    expect(text).toContain('bare')
    expect(text).toContain('~/.claude/plugins/bare')
    expect(text).toContain('This plugin has no manifest.')
    expect(text).toContain('PLUGIN · MARKETPLACE-A · V0.0.1 · USER SCOPE')

    act(() => root.unmount())
  })

  const openDemoDrillIn = async (root: ReturnType<typeof createRoot>) => {
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()
    act(() => {
      openCard(cardFor('demo'))
    })
    await flush()
  }
  let Plugins: typeof import('../Plugins').Plugins
  let toastError: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    const { toast } = await import('../../../state/toast')
    toastError = vi.spyOn(toast, 'error').mockImplementation(() => '')
    ;({ Plugins } = await import('../Plugins'))
  })

  it('keeps the open detail mounted across an external manifest change', async () => {
    const api = installWindowApiMock()
    const root = createRoot(container)
    await openDemoDrillIn(root)
    expect(container.textContent).toContain('Reviews things carefully.')

    // Hold the re-read open so the refresh is observably in flight.
    const baseline = api.config.readJson.getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    api.config.readJson.mockImplementation(async (path: string) => {
      if (path === `${HOME}/.claude/plugins/installed_plugins.json`) await gate
      return baseline(path)
    })
    act(() => api.fireChange())
    await flush()
    expect(container.textContent).not.toContain('scanning plugins')
    expect(container.textContent).toContain('Reviews things carefully.')

    release()
    await flush()
    expect(container.textContent).not.toContain('scanning plugins')
    expect(container.textContent).toContain('Reviews things carefully.')
    expect(cardFor('demo').getAttribute('aria-selected')).toBe('true')
    act(() => root.unmount())
  })

  it('shows an error state (not the empty state) and toasts once for an unparseable installed_plugins.json', async () => {
    const api = installWindowApiMock()
    api.config.readJson.mockImplementation(
      async () =>
        ({ exists: true, parseError: true, data: null, mtimeMs: 0, error: 'Unexpected token' }) as never,
    )
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(String(toastError.mock.calls[0][0])).toContain('installed_plugins.json')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('installed_plugins.json')
    expect(container.textContent).not.toContain('No plugins installed')
    act(() => root.unmount())
  })

  it('keeps previous rows visible when a refresh fails', async () => {
    const api = installWindowApiMock()
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()
    api.config.readJson.mockRejectedValue(new Error('EIO'))
    act(() => api.fireChange())
    await flush()

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')).toBeTruthy()
    expect(cards().length).toBe(2)
    act(() => root.unmount())
  })

  it('lists the other plugins when one plugin inspection throws', async () => {
    const api = installWindowApiMock()
    const baseline = api.config.exists.getMockImplementation()!
    api.config.exists.mockImplementation(async (path: string) => {
      if (path.startsWith(NO_MANIFEST_PATH)) throw new Error('EACCES')
      return baseline(path)
    })
    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    expect(cards().length).toBe(2)
    expect(cardFor('demo')).toBeTruthy()
    expect(cardFor('bare').textContent).toContain('marketplace-a · inspection failed')
    act(() => root.unmount())
  })

  describe('manifest-declared components', () => {
    type Api = ReturnType<typeof installWindowApiMock>
    const jsonRes = (data: unknown) => ({ exists: true, parseError: false, data, mtimeMs: 0, error: null })
    const fileEntry = (dir: string, name: string) => ({
      name, path: `${dir}/${name}`, isDirectory: false, isFile: true, mtimeMs: 0, size: 0,
    })

    /** Overlay disk content for the demo plugin on top of the default mock. */
    const overlay = (
      api: Api,
      disk: { manifest?: unknown; mcpJson?: unknown; dirs?: Record<string, string[]>; text?: Record<string, string> },
    ) => {
      const json = api.config.readJson.getMockImplementation()!
      const list = api.config.listDir.getMockImplementation()!
      const text = api.config.readText.getMockImplementation()!
      api.config.readJson.mockImplementation(async (path: string) => {
        if (disk.manifest !== undefined && path === `${PLUGIN_PATH}/.claude-plugin/plugin.json`) {
          return jsonRes(disk.manifest) as never
        }
        if (disk.mcpJson !== undefined && path === `${PLUGIN_PATH}/.mcp.json`) return jsonRes(disk.mcpJson) as never
        return json(path)
      })
      api.config.listDir.mockImplementation(async (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }) => {
        const names = disk.dirs?.[path]
        if (names && opts?.filesOnly) return { ok: true, error: null, entries: names.map((n) => fileEntry(path, n)) }
        return list(path, opts)
      })
      api.config.readText.mockImplementation(async (path: string) => {
        const t = disk.text?.[path]
        if (t !== undefined) return { exists: true, text: t, mtimeMs: 0, error: null }
        return text(path)
      })
    }

    const openSection = async () => {
      const root = createRoot(container)
      await openDemoDrillIn(root)
      return root
    }

    it('lists servers declared inline in plugin.json mcpServers', async () => {
      const api = installWindowApiMock()
      overlay(api, { manifest: { ...DEMO_MANIFEST, mcpServers: { inline: { command: 'node-inline' } } } })
      const root = await openSection()
      expect(container.textContent).toContain('inline')
      expect(container.textContent).toContain('node-inline')
      act(() => root.unmount())
    })

    it('lists commands from a custom commands path declared in plugin.json', async () => {
      const api = installWindowApiMock()
      overlay(api, {
        manifest: { ...DEMO_MANIFEST, commands: './custom-cmds' },
        dirs: { [`${PLUGIN_PATH}/custom-cmds`]: ['deploy.md', 'notes.txt'] },
        text: { [`${PLUGIN_PATH}/custom-cmds/deploy.md`]: '---\ndescription: Ships it.\n---\nbody\n' },
      })
      const root = await openSection()
      expect(container.textContent).toContain('deploy')
      expect(container.textContent).toContain('Ships it.')
      expect(container.textContent).not.toContain('notes')
      act(() => root.unmount())
    })

    it('lists servers from a bare-map .mcp.json', async () => {
      const api = installWindowApiMock()
      const exists = api.config.exists.getMockImplementation()!
      api.config.exists.mockImplementation(async (p: string) => p === `${PLUGIN_PATH}/.mcp.json` || exists(p))
      overlay(api, { mcpJson: { alpha: { command: 'run-alpha' }, beta: { url: 'https://beta.example' } } })
      const root = await openSection()
      expect(container.textContent).toContain('alpha')
      expect(container.textContent).toContain('run-alpha')
      expect(container.textContent).toContain('beta')
      act(() => root.unmount())
    })

    it('ignores a manifest path that escapes the plugin root, with a warning', async () => {
      const api = installWindowApiMock()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      overlay(api, {
        manifest: { ...DEMO_MANIFEST, commands: ['../escape'] },
        dirs: { [`${HOME}/.claude/plugins/escape`]: ['evil.md'] },
      })
      const root = await openSection()
      expect(container.textContent).not.toContain('evil')
      expect(api.config.listDir.mock.calls.some((c) => String(c[0]).includes('escape'))).toBe(false)
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0][0])).toContain('../escape')
      warn.mockRestore()
      act(() => root.unmount())
    })

    it('does not crash on a wrong-typed hooks value in plugin.json', async () => {
      const api = installWindowApiMock()
      overlay(api, { manifest: { ...DEMO_MANIFEST, hooks: 42, commands: 7, mcpServers: 'x' } })
      const root = await openSection()
      expect(container.textContent).toContain('my-agent')
      expect(toastError).not.toHaveBeenCalled()
      act(() => root.unmount())
    })
  })

  describe('live detail reload', () => {
    const NEW_AGENT_MD = `---\nname: new-agent\ndescription: Freshly added.\n---\n`
    const DEBOUNCE_MS = 250

    const openAgents = async (api: ReturnType<typeof installWindowApiMock>, root: ReturnType<typeof createRoot>) => {
      await openDemoDrillIn(root)
      api.config.listDir.mockClear()
    }
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
      await flushAsync(30)
    }
    const agentListCalls = (api: ReturnType<typeof installWindowApiMock>) =>
      api.config.listDir.mock.calls.filter((c) => c[0] === `${PLUGIN_PATH}/agents`).length

    afterEach(() => {
      vi.useRealTimers()
    })

    it('reloads once after a change on agents/ and shows the new agent; rapid events coalesce; leaving unwatches', async () => {
      const api = installWindowApiMock()
      const root = createRoot(container)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await openAgents(api, root)

      expect(api.config.watch).toHaveBeenCalledWith(
        expect.arrayContaining([`${PLUGIN_PATH}/agents`, `${PLUGIN_PATH}/.claude-plugin/plugin.json`]),
        { depth: 0 },
      )
      const watched = api.config.watch.mock.calls.at(-1)![0] as string[]
      expect(watched.every((p) => p.startsWith(PLUGIN_PATH))).toBe(true)
      expect(watched).not.toContain(`${PLUGIN_PATH}/commands`)

      api.agentFiles['new-agent.md'] = NEW_AGENT_MD
      for (let i = 0; i < 10; i++) {
        act(() => api.fireAt(`${PLUGIN_PATH}/agents`))
        await advance(20)
      }
      expect(agentListCalls(api)).toBe(0)
      expect(container.textContent).toContain('my-agent')
      await advance(DEBOUNCE_MS)

      expect(agentListCalls(api)).toBe(1)
      expect(container.textContent).toContain('new-agent')
      expect(container.textContent).toContain('Freshly added.')

      // Selecting another plugin unmounts this detail and drops its watch.
      api.config.unwatch.mockClear()
      act(() => openCard(cardFor('bare')))
      await flush()
      expect(api.config.unwatch).toHaveBeenCalledWith(expect.arrayContaining([`${PLUGIN_PATH}/agents`]), { depth: 0 })
      act(() => root.unmount())
    })

    it('keeps the previous detail and toasts when a reload fails', async () => {
      const api = installWindowApiMock()
      const root = createRoot(container)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await openAgents(api, root)

      api.config.readText.mockRejectedValue(new Error('EIO'))
      act(() => api.fireAt(`${PLUGIN_PATH}/agents`))
      await advance(DEBOUNCE_MS)

      expect(toastError).toHaveBeenCalledTimes(1)
      expect(String(toastError.mock.calls[0][0])).toContain('EIO')
      expect(container.textContent).toContain('Reviews things carefully.')
      act(() => root.unmount())
    })

    it('follows an in-flight reload with at most one trailing reload', async () => {
      const api = installWindowApiMock()
      const root = createRoot(container)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      await openAgents(api, root)

      const baseline = api.config.listDir.getMockImplementation()!
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      api.config.listDir.mockImplementationOnce(async (...a: Parameters<typeof baseline>) => {
        await gate
        return baseline(...a)
      })
      act(() => api.fireAt(`${PLUGIN_PATH}/agents`))
      await advance(DEBOUNCE_MS)
      act(() => api.fireAt(`${PLUGIN_PATH}/agents`))
      await advance(DEBOUNCE_MS)
      act(() => api.fireAt(`${PLUGIN_PATH}/agents`))
      await advance(DEBOUNCE_MS)
      expect(container.textContent).toContain('my-agent')

      release()
      await advance(DEBOUNCE_MS)
      expect(agentListCalls(api)).toBe(2)
      act(() => root.unmount())
    })
  })

  describe('skill count and install scope', () => {
    const jsonRes = (data: unknown) => ({ exists: true, parseError: false, data, mtimeMs: 0, error: null })
    const dirEntry = (dir: string, name: string) => ({
      name, path: `${dir}/${name}`, isDirectory: true, isFile: false, mtimeMs: 0, size: 0,
    })

    it('shows the same skill count in the row and the detail when only some folders hold a SKILL.md', async () => {
      const api = installWindowApiMock()
      const list = api.config.listDir.getMockImplementation()!
      const text = api.config.readText.getMockImplementation()!
      api.config.listDir.mockImplementation(async (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }) => {
        if (path === `${PLUGIN_PATH}/skills` && opts?.dirsOnly) {
          return { ok: true, error: null, entries: ['alpha', 'beta', 'empty'].map((n) => dirEntry(path, n)) } as never
        }
        return list(path, opts)
      })
      api.config.readText.mockImplementation(async (path: string) => {
        const m = /\/skills\/(alpha|beta)\/SKILL\.md$/.exec(path)
        if (m) return { exists: true, text: `---\nname: ${m[1]}\ndescription: d.\n---\n`, mtimeMs: 0, error: null }
        return text(path)
      })
      const { Plugins } = await import('../Plugins')
      const root = createRoot(container)
      act(() => root.render(createElement(Plugins)))
      await flush()

      const demo = cardFor('demo')
      expect(demo.textContent).toContain('2 skills')
      expect(demo.textContent).not.toContain('3 skills')
      act(() => openCard(demo))
      await flush()
      expect(detailText()).toContain('2 SKILLS')
      expect(detailText()).toContain('alpha')
      expect(detailText()).toContain('beta')
      expect(detailText()).not.toContain('empty')
      act(() => root.unmount())
    })

    it('renders each install scope so same-name installs are distinguishable', async () => {
      const api = installWindowApiMock()
      const PROJECT_PATH = `${HOME}/proj/.claude/plugins/demo`
      const json = api.config.readJson.getMockImplementation()!
      api.config.readJson.mockImplementation(async (path: string) => {
        if (path === `${HOME}/.claude/plugins/installed_plugins.json`) {
          return jsonRes({
            version: 1,
            plugins: {
              'demo@marketplace-a': [
                { scope: 'user', installPath: PLUGIN_PATH, version: '1.2.3', installedAt: '', lastUpdated: '' },
                { scope: 'project', installPath: PROJECT_PATH, version: '1.2.3', installedAt: '', lastUpdated: '' },
              ],
            },
          }) as never
        }
        return json(path)
      })
      const { Plugins } = await import('../Plugins')
      const root = createRoot(container)
      act(() => root.render(createElement(Plugins)))
      await flush()

      const rows = cards()
      expect(rows).toHaveLength(2)
      const metas = rows.map((r) => r.textContent ?? '')
      expect(metas.filter((m) => m.includes('project scope'))).toHaveLength(1)
      const projectRow = rows.find((r) => r.textContent?.includes('project scope'))!
      act(() => openCard(projectRow))
      await flush()
      expect(detailText()).toContain('PROJECT SCOPE')
      act(() => root.unmount())
    })

    it('empty state names the real install sources, not a drop-in directory', async () => {
      const api = installWindowApiMock()
      const json = api.config.readJson.getMockImplementation()!
      api.config.readJson.mockImplementation(async (path: string) =>
        path === `${HOME}/.claude/plugins/installed_plugins.json` ? (jsonRes({ version: 1, plugins: {} }) as never) : json(path),
      )
      const { Plugins } = await import('../Plugins')
      const root = createRoot(container)
      act(() => root.render(createElement(Plugins)))
      await flush()
      expect(container.textContent).toContain('claude plugin install')
      expect(container.textContent).not.toContain('drop a plugin')
      act(() => root.unmount())
    })
  })
})
