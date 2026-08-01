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
 * Clicking an installed-plugin row navigates to a full drill-in page
 * (PluginHomePage) in place of the table: one-line header, meta strip,
 * left section index, and real skill/agent data. A back link returns to
 * the list.
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
  author: { name: 'Stanislav' },
  license: 'MIT',
  homepage: 'https://example.com/demo',
}

const SKILL_MD = `---\nname: my-skill\ndescription: Does the skill thing. More detail here.\n---\nBody text.\n`
const AGENT_MD = `---\nname: my-agent\ndescription: Reviews things carefully.\n---\nAgent body.\n`

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      exists: vi.fn(async (path: string) => {
        return (
          path === `${PLUGIN_PATH}/.claude-plugin/plugin.json` ||
          path === `${PLUGIN_PATH}/skills` // not used by exists, harmless
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
        if (path === `${PLUGIN_PATH}/agents/my-agent.md`) {
          return { exists: true, text: AGENT_MD, mtimeMs: 0, error: null }
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
            entries: [
              {
                name: 'my-agent.md',
                path: `${PLUGIN_PATH}/agents/my-agent.md`,
                isDirectory: false,
                isFile: true,
                mtimeMs: 0,
                size: 0,
              },
            ],
          }
        }
        return { ok: true, error: null, entries: [] }
      }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    shell: {
      open: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const flush = () => flushAsync(5)

describe('Plugins drill-in page', () => {
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

  it('navigates to the plugin home page on row click, shows header/meta/sections, and returns via back link', async () => {
    const api = installWindowApiMock()
    const { Plugins } = await import('../Plugins')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    const demoRow = Array.from(container.querySelectorAll('tr[data-row-key]')).find((r) =>
      r.textContent?.includes('demo'),
    ) as HTMLElement
    expect(demoRow).toBeTruthy()

    act(() => {
      demoRow.click()
    })
    await flush()

    // Table is gone; page header shows name, version, back link.
    expect(container.querySelector('table')).toBeFalsy()
    const text = container.textContent ?? ''
    expect(text).toContain('demo')
    expect(text).toContain('v1.2.3')
    expect(text).toContain('Plugins')

    // Meta strip.
    expect(text).toContain('Stanislav')
    expect(text).toContain('MIT')
    expect(text).toContain('example.com/demo')

    // Section index + real skill/agent data.
    expect(text).toContain('my-skill')
    expect(text).toContain('Does the skill thing.')

    const agentsButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.trim().startsWith('Agents'),
    ) as HTMLButtonElement
    expect(agentsButton).toBeTruthy()
    act(() => {
      agentsButton.click()
    })
    await flush()
    expect(container.textContent).toContain('my-agent')
    expect(container.textContent).toContain('Reviews things carefully.')

    // Back link returns to the list view.
    const backLink = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Plugins'),
    ) as HTMLButtonElement
    expect(backLink).toBeTruthy()
    act(() => {
      backLink.click()
    })
    await flush()
    expect(container.querySelector('table')).toBeTruthy()

    expect(api.config.readJson).toHaveBeenCalled()
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

    const demoRow = Array.from(container.querySelectorAll('tr[data-row-key]')).find((r) =>
      r.textContent?.includes('demo'),
    ) as HTMLElement
    act(() => {
      demoRow.click()
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

    // Plugin Home body (section index) is replaced by the full-page Skill Home.
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

    // Back to Plugin Home's Skills section list — not the outer Plugins table.
    expect(container.querySelector('table')).toBeFalsy()
    const afterBackText = container.textContent ?? ''
    expect(afterBackText).toContain('my-skill')
    expect(afterBackText).toContain('Does the skill thing.')
    expect(afterBackText).not.toContain('Body text.')

    act(() => root.unmount())
  })

  it('handles a plugin with no manifest: shows directory name and just PATH, no crash', async () => {
    installWindowApiMock()
    const { Plugins } = await import('../Plugins')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Plugins))
    })
    await flush()

    const bareRow = Array.from(container.querySelectorAll('tr[data-row-key]')).find((r) =>
      r.textContent?.includes('bare'),
    ) as HTMLElement
    expect(bareRow).toBeTruthy()

    act(() => {
      bareRow.click()
    })
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('bare')
    expect(text).toContain(NO_MANIFEST_PATH)
    // No author/license/homepage keys since manifest is absent.
    expect(text).not.toContain('AUTHOR')

    act(() => root.unmount())
  })
})
