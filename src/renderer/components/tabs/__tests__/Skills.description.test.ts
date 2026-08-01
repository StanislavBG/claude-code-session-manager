// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushAsync } from '../../../testUtils/domFlush'

/**
 * Sidebar rows should surface each skill's SKILL.md frontmatter description
 * (when present) as a muted line under the name, and show nothing extra when
 * a skill has no description — Skills.tsx wires parseSkillMeta's description
 * field into the Item list for exactly this.
 */

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => null,
}))

const SKILL_WITH_DESC = [
  '---',
  'name: with-desc',
  'description: Does the one thing well.',
  '---',
  '',
  'body',
].join('\n')

const SKILL_NO_DESC = ['---', 'name: no-desc', '---', '', 'body'].join('\n')

function installWindowApiMock() {
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue('/home/test') },
    config: {
      listDir: vi.fn(async (path: string, opts?: { filesOnly?: boolean; dirsOnly?: boolean }) => {
        if (path === '/home/test/.claude/skills' && opts?.dirsOnly) {
          return {
            ok: true,
            error: null,
            entries: [
              { name: 'with-desc', path: '/home/test/.claude/skills/with-desc', isDirectory: true, isFile: false, mtimeMs: 0, size: 0 },
              { name: 'no-desc', path: '/home/test/.claude/skills/no-desc', isDirectory: true, isFile: false, mtimeMs: 0, size: 0 },
            ],
          }
        }
        if (path === '/home/test/.claude/commands' && opts?.filesOnly) {
          return { ok: true, error: null, entries: [] }
        }
        return { ok: true, error: null, entries: [] }
      }),
      readText: vi.fn(async (path: string) => {
        if (path === '/home/test/.claude/skills/with-desc/SKILL.md') {
          return { exists: true, text: SKILL_WITH_DESC, mtimeMs: 0, error: null }
        }
        if (path === '/home/test/.claude/skills/no-desc/SKILL.md') {
          return { exists: true, text: SKILL_NO_DESC, mtimeMs: 0, error: null }
        }
        return { exists: false, text: '', mtimeMs: 0, error: null }
      }),
      readJson: vi.fn().mockResolvedValue({ ok: true, data: null, error: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 0 }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return api
}

const flush = () => flushAsync(3)

describe('Skills sidebar description', () => {
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

  it('shows the frontmatter description for a skill that has one, and nothing for one that does not', async () => {
    installWindowApiMock()
    const { Skills } = await import('../Skills')

    const root = createRoot(container)
    act(() => {
      root.render(createElement(Skills))
    })
    await flush()

    const text = container.textContent ?? ''
    expect(text).toContain('Does the one thing well.')

    const rows = Array.from(container.querySelectorAll('div.mb-3'))
    const noDescRow = rows
      .flatMap((group) => Array.from(group.querySelectorAll('button')))
      .find((btn) => btn.textContent?.includes('no-desc'))
    expect(noDescRow).toBeTruthy()
    expect(noDescRow?.textContent).toBe('no-desc')

    act(() => root.unmount())
  })
})
