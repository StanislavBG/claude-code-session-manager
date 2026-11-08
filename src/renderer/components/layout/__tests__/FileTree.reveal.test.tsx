// @vitest-environment jsdom
/**
 * FileTree `reveal` prop — what ProjectsWorkspace hands it for a `reveal:<path>`
 * hint (lib/revealInFileExplorer.ts). Once the tree has loaded it expands the
 * folders down to the target, selects the target row and scrolls it into view.
 */
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree, type FileTreeReveal } from '../FileTree'
import { useToast } from '../../../state/toast'
import { flushAsync } from '../../../testUtils/domFlush'

const HOME = '/home/u'
const CLAUDE = `${HOME}/.claude`
const SKILLS = `${CLAUDE}/skills`
const FOO = `${SKILLS}/foo`
const TARGET = `${FOO}/SKILL.md`
const SETTINGS_PREFS = '~/.claude/session-manager/ui-settings-prefs.json'
const PROJECT_PREFS = `${HOME}/session-manager-operations/ui-prefs/prefs.json`

// Folder → [name, isDirectory] rows.
const FS: Record<string, Array<[string, boolean]>> = {
  [HOME]: [['.claude', true], ['Projects', true], ['notes.md', false]],
  [CLAUDE]: [['skills', true], ['settings.json', false]],
  [SKILLS]: [['bar', true], ['foo', true]],
  [FOO]: [['SKILL.md', false]],
  [`${SKILLS}/bar`]: [],
  [`${HOME}/Projects`]: [],
}

function listing(dir: string, showHidden: boolean) {
  const rows = FS[dir]
  if (!rows) return { ok: false, entries: [], error: 'ENOENT' }
  return {
    ok: true,
    entries: rows
      .filter(([name]) => showHidden || !name.startsWith('.'))
      .map(([name, isDirectory]) => ({ name, path: `${dir}/${name}`, isDirectory, isFile: !isDirectory, size: 0, mtimeMs: 0 })),
  }
}

const list = vi.fn()
const writeJson = vi.fn()
let settingsPrefs: Record<string, unknown> | null = null
let projectPrefs: Record<string, unknown> | null = null
const scrolled: Element[] = []
const realScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

beforeEach(() => {
  settingsPrefs = null
  projectPrefs = null
  scrolled.length = 0
  list.mockReset()
  list.mockImplementation(async (dir: string, showHidden: boolean) => listing(dir, showHidden))
  writeJson.mockReset()
  writeJson.mockResolvedValue(undefined)
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: function (this: Element) { scrolled.push(this) },
  })
  ;(window as unknown as { api: unknown }).api = {
    files: { list },
    git: { fileStatus: vi.fn().mockResolvedValue({}) },
    shell: { open: vi.fn().mockResolvedValue({ ok: true }) },
    config: {
      readJson: vi.fn(async (p: string) => {
        const data = p === SETTINGS_PREFS ? settingsPrefs : p === PROJECT_PREFS ? projectPrefs : null
        return data ? { exists: true, data } : { exists: false, data: null }
      }),
      writeJson,
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  if (realScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', realScrollIntoView)
  else delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
})

type Extra = { reveal?: FileTreeReveal | null; onRevealDone?: (token: number) => void }

async function render(extra: Extra = {}) {
  await act(async () => { root!.render(createElement(FileTree, { cwd: HOME, ...extra })) })
  await flushAsync()
}

async function mount(extra: Extra = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await render(extra)
  return container
}

async function until(check: () => void) {
  await vi.waitFor(async () => { await flushAsync(); check() }, { timeout: 2000 })
}

const row = (c: HTMLElement, path: string) => c.querySelector<HTMLElement>(`[data-path="${path}"]`)
const selectedPaths = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('[data-selected="true"]')).map((el) => el.dataset.path)

describe('FileTree reveal', () => {
  it('expands the folders down to the target, selects it and scrolls it into view', async () => {
    const onRevealDone = vi.fn()
    const c = await mount({ reveal: { path: TARGET, token: 1 }, onRevealDone })

    await until(() => expect(selectedPaths(c)).toEqual([TARGET]))
    for (const dir of [CLAUDE, SKILLS, FOO]) expect(row(c, dir)).not.toBeNull()
    expect(scrolled).toEqual([row(c, TARGET)])
    expect(onRevealDone).toHaveBeenCalledWith(1)
    // The opened folders persist like any user expansion.
    await until(() => expect(writeJson).toHaveBeenCalledWith(
      PROJECT_PREFS,
      expect.objectContaining({ fileTreeExpanded: expect.arrayContaining([CLAUDE, SKILLS, FOO]) }),
      'ui-prefs',
    ))

    // A click moves the selection; a new reveal of the same path brings it back.
    await act(async () => { row(c, `${SKILLS}/bar`)!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(selectedPaths(c)).toEqual([`${SKILLS}/bar`])
    await render({ reveal: { path: TARGET, token: 2 }, onRevealDone })
    await until(() => expect(selectedPaths(c)).toEqual([TARGET]))
    expect(scrolled).toHaveLength(2)
    expect(onRevealDone).toHaveBeenLastCalledWith(2)
  })

  it('shows hidden files for a target under a hidden folder, without saving that as the preference', async () => {
    settingsPrefs = { fileTreeShowHidden: false }
    const c = await mount()
    await until(() => expect(c.querySelector('button[title="Show hidden files"]')).not.toBeNull())
    expect(row(c, CLAUDE)).toBeNull()

    await render({ reveal: { path: TARGET, token: 1 } })

    await until(() => expect(selectedPaths(c)).toEqual([TARGET]))
    expect(c.querySelector('button[title="Hide hidden files"]')).not.toBeNull()
    expect(writeJson.mock.calls.some(([p]) => p === SETTINGS_PREFS)).toBe(false)
  })

  it('keeps the revealed subtree when a slower restore of an expanded parent lands after it', async () => {
    projectPrefs = { fileTreeExpanded: [CLAUDE] }
    let releaseRestore: () => void = () => {}
    let firstClaudeList = true
    list.mockImplementation(async (dir: string, showHidden: boolean) => {
      if (dir === CLAUDE && firstClaudeList) {
        firstClaudeList = false
        await new Promise<void>((resolve) => { releaseRestore = resolve })
      }
      return listing(dir, showHidden)
    })
    const c = await mount({ reveal: { path: TARGET, token: 1 } })
    await until(() => expect(selectedPaths(c)).toEqual([TARGET]))

    await act(async () => { releaseRestore() })
    await flushAsync()

    expect(row(c, TARGET)).not.toBeNull()
    expect(selectedPaths(c)).toEqual([TARGET])
  })

  it('toasts and reports the reveal done when the target is not in the tree', async () => {
    const onRevealDone = vi.fn()
    const c = await mount({ reveal: { path: `${SKILLS}/nope.md`, token: 7 }, onRevealDone })

    await until(() => expect(onRevealDone).toHaveBeenCalledWith(7))
    expect(selectedPaths(c)).toEqual([])
    expect(useToast.getState().toasts.some((t) => t.kind === 'error' && t.message.includes('nope.md'))).toBe(true)
  })
})
