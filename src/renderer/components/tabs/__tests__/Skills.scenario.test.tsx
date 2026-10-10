// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { Skills } from '../Skills'
import { useLayout } from '../../../state/layout'
import { useSessions } from '../../../state/sessions'
import { useConfig } from '../../../state/config'
import { toast } from '../../../state/toast'

/** Scenario tests for the Skills page write paths (toggle, remove). */

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'markdown-editor' }),
}))

const HOME = '/home/bilko'
const SKILLS_DIR = `${HOME}/.claude/skills`
const ONE = `${SKILLS_DIR}/skill-one/SKILL.md`
const TWO = `${SKILLS_DIR}/skill-two/SKILL.md`

const md = (name: string, extra: string[] = []) =>
  ['---', `name: ${name}`, `description: ${name} desc`, ...extra, '---', '', 'body'].join('\n')

function installApi() {
  const disk: Record<string, string> = { [ONE]: md('skill-one'), [TWO]: md('skill-two') }
  const dir = (n: string) => ({ name: n, path: `${SKILLS_DIR}/${n}`, isDirectory: true, isFile: false, mtimeMs: 0, size: 0 })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn(async (path: string, opts?: { dirsOnly?: boolean }) => {
        if (path === SKILLS_DIR && opts?.dirsOnly) {
          return { ok: true, error: null, entries: ['skill-one', 'skill-two'].map(dir) }
        }
        return { ok: true, error: null, entries: [] }
      }),
      readText: vi.fn(async (path: string) =>
        path in disk
          ? { exists: true, text: disk[path], mtimeMs: 0, error: null }
          : { exists: false, text: '', mtimeMs: 0, error: null }
      ),
      writeText: vi.fn(async (path: string, text: string) => {
        disk[path] = text
        return { ok: true }
      }),
      watch: vi.fn(),
      unwatch: vi.fn(),
      onChanged: vi.fn(() => () => {}),
    },
    files: { delete: vi.fn().mockResolvedValue({ ok: true }) },
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, disk }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(Skills))
    await flush()
  })
  return container
}

const toggleFor = (el: HTMLElement, name: string) => {
  const row = Array.from(el.querySelectorAll('div')).find(
    (d) => d.querySelector('[role="switch"]') && d.textContent?.includes(name) && d.className.includes('justify-between')
  )
  return row!.querySelector('[role="switch"]') as HTMLButtonElement
}
const click = async (b: Element) => {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
  })
}
const buttonByText = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)

beforeEach(() => {
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
  vi.restoreAllMocks()
})

describe('Skills enable toggle', () => {
  it('writes the toggled frontmatter for a clean skill and reloads without discarding drafts', async () => {
    const { api, disk } = installApi()
    const el = await mount()
    const loadText = vi.spyOn(useConfig.getState(), 'loadText')
    useConfig.setState({ loadText })
    await click(toggleFor(el, 'skill-one'))
    expect(api.config.writeText).toHaveBeenCalledTimes(1)
    expect(disk[ONE]).toContain('disable-model-invocation: true')
    expect(loadText).toHaveBeenCalledWith(ONE, true)
  })

  it('disables the toggle with a tooltip and never writes while the draft is dirty', async () => {
    const { api } = installApi()
    const el = await mount()
    act(() => {
      const f = useConfig.getState().files[ONE]
      useConfig.setState({ files: { ...useConfig.getState().files, [ONE]: { ...f, dirty: true, draftRaw: 'unsaved' } } })
    })
    const sw = toggleFor(el, 'skill-one')
    expect(sw.disabled).toBe(true)
    expect(sw.closest('[title]')?.getAttribute('title')).toMatch(/unsaved edits/i)
    await click(sw)
    expect(api.config.writeText).not.toHaveBeenCalled()
  })

  it('toasts an error and leaves the list unchanged when the write fails', async () => {
    const { api } = installApi()
    api.config.writeText.mockResolvedValueOnce({ ok: false, error: 'disk full' } as never)
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const el = await mount()
    const before = toggleFor(el, 'skill-one').getAttribute('aria-checked')
    await click(toggleFor(el, 'skill-one'))
    expect(err).toHaveBeenCalledWith('disk full')
    expect(toggleFor(el, 'skill-one').getAttribute('aria-checked')).toBe(before)
  })
})

describe('Skills remove', () => {
  it('asks via the in-app confirm, deletes on confirm and selects a remaining skill', async () => {
    const { api } = installApi()
    const winConfirm = vi.spyOn(window, 'confirm')
    const el = await mount()
    await click(el.querySelector('[aria-label="Remove skill-one"]')!)
    expect(winConfirm).not.toHaveBeenCalled()
    expect(api.files.delete).not.toHaveBeenCalled()
    await click(buttonByText(el, 'confirm')!)
    expect(api.files.delete).toHaveBeenCalledWith(`${SKILLS_DIR}/skill-one`)
    expect(el.textContent).not.toContain('skill-one')
    expect(el.querySelector(`[aria-label="Remove skill-two"]`)).not.toBeNull()
    expect(useConfig.getState().files[TWO]).toBeDefined()
  })

  it('does nothing on cancel', async () => {
    const { api } = installApi()
    const el = await mount()
    await click(el.querySelector('[aria-label="Remove skill-one"]')!)
    await click(buttonByText(el, 'cancel')!)
    expect(api.files.delete).not.toHaveBeenCalled()
    expect(el.textContent).toContain('skill-one')
    expect(buttonByText(el, 'confirm')).toBeUndefined()
  })
})

describe('Skills list errors', () => {
  const errorState = (el: HTMLElement) => el.querySelector('[data-testid="skills-list-error"]')

  it('shows an error state (not the empty state) and toasts once when the skills base cannot be listed', async () => {
    const { api } = installApi()
    api.config.listDir.mockImplementation((async (path: string) =>
      path === SKILLS_DIR
        ? { ok: false, error: 'EACCES: permission denied', entries: [] }
        : { ok: true, error: null, entries: [] }) as never)
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const el = await mount()
    expect(errorState(el)).not.toBeNull()
    expect(el.textContent).toContain(SKILLS_DIR)
    expect(el.textContent).not.toContain('no skills or commands')
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0][0]).toContain(SKILLS_DIR)
  })

  it('survives a rejected listDir without an unhandled rejection and toasts', async () => {
    const { api } = installApi()
    api.config.listDir.mockRejectedValue(new Error('ipc boom'))
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const el = await mount()
    await new Promise((r) => setTimeout(r, 0))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
    expect(err.mock.calls[0][0]).toContain('ipc boom')
    expect(errorState(el)).not.toBeNull()
  })

  it('still lists the skills that loaded when one read fails', async () => {
    const { api, disk } = installApi()
    const base = api.config.readText.getMockImplementation()!
    api.config.readText.mockImplementation(async (path: string) => {
      if (path === TWO) throw new Error('read denied')
      return base(path)
    })
    void disk
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const el = await mount()
    expect(el.textContent).toContain('skill-one')
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0][0]).toContain(TWO)
    expect(errorState(el)).toBeNull()
  })
})
