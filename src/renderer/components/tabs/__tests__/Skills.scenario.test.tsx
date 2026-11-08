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

/** Scenario tests for the Skills page: the 3a list column and its write paths (toggle, remove). */

vi.mock('../../ui/MarkdownEditor', () => ({
  MarkdownEditor: () => createElement('div', { 'data-testid': 'markdown-editor' }),
}))

const HOME = '/home/bilko'
const SKILLS_DIR = `${HOME}/.claude/skills`
const COMMANDS_DIR = `${HOME}/.claude/commands`
const ONE = `${SKILLS_DIR}/skill-one/SKILL.md`
const TWO = `${SKILLS_DIR}/skill-two/SKILL.md`

const md = (name: string, extra: string[] = []) =>
  ['---', `name: ${name}`, `description: ${name} desc`, ...extra, '---', '', 'body'].join('\n')
const commandMd = (description: string) => ['---', `description: ${description}`, '---', '', 'body'].join('\n')

/** `skills` are folder names under SKILLS_DIR; `commands` maps a command name to its description. */
function installApi({
  skills = ['skill-one', 'skill-two'],
  commands = {},
}: { skills?: string[]; commands?: Record<string, string> } = {}) {
  const disk: Record<string, string> = {}
  for (const n of skills) disk[`${SKILLS_DIR}/${n}/SKILL.md`] = md(n)
  for (const [n, description] of Object.entries(commands)) disk[`${COMMANDS_DIR}/${n}.md`] = commandMd(description)
  const entry = (name: string, path: string, isDirectory: boolean) =>
    ({ name, path, isDirectory, isFile: !isDirectory, mtimeMs: 0, size: 0 })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    config: {
      listDir: vi.fn(async (path: string, opts?: { dirsOnly?: boolean; filesOnly?: boolean }) => {
        if (path === SKILLS_DIR && opts?.dirsOnly) {
          return { ok: true, error: null, entries: skills.map((n) => entry(n, `${SKILLS_DIR}/${n}`, true)) }
        }
        if (path === COMMANDS_DIR && opts?.filesOnly) {
          return { ok: true, error: null, entries: Object.keys(commands).map((n) => entry(`${n}.md`, `${COMMANDS_DIR}/${n}.md`, false)) }
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

async function mount(props: { onAdd?: () => void; scope?: 'user' | 'project' } = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<Skills {...props} />)
    await flush()
  })
  return container
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const classes = (el: Element | null | undefined) => (el?.getAttribute('class') ?? '').split(/\s+/)
/** The list's cards, in display order, and the `/name` each one shows. */
const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="skills-item"]'))
const nameOf = (card: HTMLElement) => q(card, 'skills-item-name')?.textContent
const listed = (el: HTMLElement) => cards(el).map(nameOf)
const cardFor = (el: HTMLElement, name: string) => cards(el).find((c) => nameOf(c) === `/${name}`)
const toggleFor = (el: HTMLElement, name: string) =>
  cardFor(el, name)!.querySelector('[role="switch"]') as HTMLButtonElement
const click = async (b: Element) => {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
  })
}
const buttonByText = (el: HTMLElement, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)
/** React tracks a controlled input's value; go through the native setter so onChange fires. */
const typeFilter = async (el: HTMLElement, value: string) => {
  const input = q(el, 'extensions-toolbar-filter') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

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
    expect(q(cardFor(el, 'skill-one')!, 'skills-item-dirty')).not.toBeNull()
    expect(q(cardFor(el, 'skill-two')!, 'skills-item-dirty')).toBeNull()
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
    // The list must not claim there are no skills when it could not look.
    expect(q(el, 'skills-empty')).toBeNull()
    expect(q(el, 'skills-list-skills-error')).not.toBeNull()
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

  it('keeps a command whose file cannot be read, without a description, and toasts the failure', async () => {
    const { api } = installApi({ commands: { deploy: 'Ship it', review: 'Review the diff' } })
    const base = api.config.readText.getMockImplementation()!
    api.config.readText.mockImplementation(async (path: string) => {
      if (path === `${COMMANDS_DIR}/deploy.md`) throw new Error('read denied')
      return base(path)
    })
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const el = await mount()
    expect(listed(el)).toEqual(['/skill-one', '/skill-two', '/deploy', '/review'])
    expect(q(cardFor(el, 'deploy')!, 'skills-item-desc')).toBeNull()
    expect(q(cardFor(el, 'review')!, 'skills-item-desc')!.textContent).toBe('Review the diff')
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0][0]).toContain(`${COMMANDS_DIR}/deploy.md`)
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

describe('Skills list refresh load', () => {
  const skillsLists = (api: ReturnType<typeof installApi>['api']) =>
    api.config.listDir.mock.calls.filter((c) => c[0] === SKILLS_DIR && c[1]?.dirsOnly).length
  const emit = (api: ReturnType<typeof installApi>['api'], path: string) =>
    (api.config.onChanged.mock.calls as unknown as Array<[(i: { path: string }) => void]>).forEach(([cb]) => cb({ path }))

  it('coalesces 20 rapid change events into one re-list', async () => {
    const { api } = installApi()
    await mount()
    const before = skillsLists(api)
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 20; i++) emit(api, SKILLS_DIR)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
        await flush()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(skillsLists(api) - before).toBe(1)
  })

  it('skips the re-list for the echo of its own just-saved skill', async () => {
    const { api } = installApi()
    await mount()
    const before = skillsLists(api)
    act(() => {
      const f = useConfig.getState().files[ONE]
      useConfig.setState({ files: { ...useConfig.getState().files, [ONE]: { ...f, lastSavedAt: Date.now() } } })
    })
    vi.useFakeTimers()
    try {
      emit(api, SKILLS_DIR)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
        await flush()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(skillsLists(api) - before).toBe(0)
  })

  it('keeps at most 6 readText calls in flight across skills and command descriptions', async () => {
    const { api } = installApi()
    const names = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const entries = (dir: string, isDirectory: boolean) =>
      names.map((n) => ({ name: isDirectory ? n : `${n}.md`, path: `${dir}/${n}${isDirectory ? '' : '.md'}`, isDirectory, isFile: !isDirectory, mtimeMs: 0, size: 0 }))
    api.config.listDir.mockImplementation((async (path: string, opts?: { dirsOnly?: boolean; filesOnly?: boolean }) =>
      path === SKILLS_DIR && opts?.dirsOnly
        ? { ok: true, error: null, entries: entries(SKILLS_DIR, true) }
        : path === COMMANDS_DIR && opts?.filesOnly
          ? { ok: true, error: null, entries: entries(COMMANDS_DIR, false) }
          : { ok: true, error: null, entries: [] }) as never)
    let inFlight = 0
    let peak = 0
    api.config.readText.mockImplementation((async (path: string) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
      return { exists: true, text: md(path), mtimeMs: 0, error: null }
    }) as never)
    const el = await mount()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(listed(el)).toHaveLength(40)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(6)
  })
})

describe('Skills config watch', () => {
  const flat = (calls: unknown[][]) => calls.flatMap((c) => c[0] as string[])

  it('watches the user-scope skills and commands directories on mount, unwatches on unmount', async () => {
    const { api } = installApi()
    await mount()
    expect(flat(api.config.watch.mock.calls)).toEqual(expect.arrayContaining([SKILLS_DIR, COMMANDS_DIR]))
    act(() => root?.unmount())
    root = null
    expect(flat(api.config.unwatch.mock.calls)).toEqual(expect.arrayContaining([SKILLS_DIR, COMMANDS_DIR]))
  })

  it('shows a skill added on disk after config:changed fires for the skills directory', async () => {
    const { api, disk } = installApi()
    const el = await mount()
    expect(el.textContent).toContain('skill-one')
    expect(el.textContent).not.toContain('skill-three')

    const THREE = `${SKILLS_DIR}/skill-three/SKILL.md`
    disk[THREE] = md('skill-three')
    const base = api.config.listDir.getMockImplementation()!
    api.config.listDir.mockImplementation((async (path: string, opts?: { dirsOnly?: boolean }) => {
      const res = await base(path, opts)
      if (path === SKILLS_DIR && opts?.dirsOnly) {
        const extra = { name: 'skill-three', path: `${SKILLS_DIR}/skill-three`, isDirectory: true, isFile: false, mtimeMs: 0, size: 0 }
        return { ...res, entries: [...res.entries, extra] }
      }
      return res
    }) as never)

    vi.useFakeTimers()
    try {
      ;(api.config.onChanged.mock.calls as unknown as Array<[(i: { path: string }) => void]>).forEach(([cb]) => cb({ path: SKILLS_DIR }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400)
        await flush()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(el.textContent).toContain('skill-three')
  })
})

describe('Skills list', () => {
  it('shows the shared toolbar: filter, counts summary and a + New menu whose Browse catalog… opens the catalog', async () => {
    installApi({ skills: ['skill-one'], commands: { deploy: 'Ship it', review: 'Review the diff' } })
    const onAdd = vi.fn()
    const el = await mount({ onAdd })
    expect((q(el, 'extensions-toolbar-filter') as HTMLInputElement).placeholder).toBe('Filter skills and commands')
    expect(q(el, 'extensions-toolbar-summary')!.textContent).toBe('1 skill · 2 commands')
    expect(buttonByText(el, 'Add…')).toBeUndefined()
    expect(q(el, 'skills-new')!.textContent).toBe('+ New')
    await click(q(el, 'skills-new')!)
    const browse = q(el, 'skills-new-browse-catalog')!
    expect(browse.textContent).toBe('Browse catalog…')
    await click(browse)
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(q(el, 'skills-new-menu')).toBeNull()
  })

  it('offers Browse catalog… only when the page has a catalog to open', async () => {
    installApi()
    const el = await mount({ scope: 'user' })
    await click(q(el, 'skills-new')!)
    expect(q(el, 'skills-new-menu')).not.toBeNull()
    expect(q(el, 'skills-new-browse-catalog')).toBeNull()
  })

  it('explains what a skill is when there are none, and Create a skill → opens the catalog', async () => {
    installApi({ skills: [] })
    const onAdd = vi.fn()
    const el = await mount({ onAdd })
    const empty = q(el, 'skills-empty')!
    expect(empty.textContent).toContain('No skills yet')
    expect(empty.textContent).toContain('A skill is a folder with a SKILL.md that Claude loads when a task calls for it.')
    expect(classes(empty)).toEqual(expect.arrayContaining(['border-dashed', 'border-rule']))
    expect(q(el, 'skills-section-skills-count')!.textContent).toBe('0')
    expect(q(el, 'extensions-toolbar-summary')!.textContent).toBe('0 skills · 0 commands')
    const link = q(el, 'skills-create-link')!
    expect(link.textContent).toBe('Create a skill →')
    await click(link)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('filters skills and commands by name or description, ignoring case', async () => {
    const { disk } = installApi({ commands: { 'refresh-claude-md': 'Audit and refresh CLAUDE.md files' } })
    disk[TWO] = md('skill-two').replace('skill-two desc', 'Deploys the Docs site')
    const el = await mount()
    expect(listed(el)).toEqual(['/skill-one', '/skill-two', '/refresh-claude-md'])

    await typeFilter(el, 'DOCS')
    expect(listed(el)).toEqual(['/skill-two'])
    expect(q(el, 'skills-section-skills-count')!.textContent).toBe('1')
    expect(q(el, 'skills-section-commands-count')!.textContent).toBe('0')

    await typeFilter(el, 'claude.md')
    expect(listed(el)).toEqual(['/refresh-claude-md'])
    // Skills exist, they just do not match: no "No skills yet" explainer.
    expect(q(el, 'skills-empty')).toBeNull()

    await typeFilter(el, 'Skill-One')
    expect(listed(el)).toEqual(['/skill-one'])
    // The summary counts everything, not just what the filter shows.
    expect(q(el, 'extensions-toolbar-summary')!.textContent).toBe('2 skills · 1 command')

    await typeFilter(el, '')
    expect(listed(el)).toHaveLength(3)
  })

  it('shows commands as cards with the mono /name, origin badge and description; selecting one moves the accent border', async () => {
    installApi({ commands: { 'refresh-claude-md': 'Audit, refresh, and split CLAUDE.md files' } })
    const el = await mount()
    expect(q(el, 'skills-section-skills-count')!.textContent).toBe('2')
    expect(q(el, 'skills-section-commands-count')!.textContent).toBe('1')
    const cmd = cardFor(el, 'refresh-claude-md')!
    expect(classes(cmd)).toEqual(expect.arrayContaining(['bg-bg-hi', 'rounded-[7px]', 'border-line']))
    expect(classes(q(cmd, 'skills-item-name'))).toContain('font-mono')
    expect(q(cmd, 'skills-item-desc')!.textContent).toBe('Audit, refresh, and split CLAUDE.md files')
    expect(cmd.querySelector('[title^="Auto-detected"]')).not.toBeNull()

    // The first skill starts selected.
    expect(classes(cardFor(el, 'skill-one'))).toContain('border-accent')
    expect(classes(cmd)).not.toContain('border-accent')
    await click(q(cmd, 'skills-item-desc')!)
    expect(classes(cmd)).toContain('border-accent')
    expect(classes(cmd)).not.toContain('border-line')
    expect(classes(cardFor(el, 'skill-one'))).not.toContain('border-accent')
  })

  it('shows the frontmatter description under a skill that has one and nothing under one that does not', async () => {
    const { disk } = installApi()
    disk[TWO] = ['---', 'name: skill-two', '---', '', 'body'].join('\n')
    const el = await mount()
    expect(q(cardFor(el, 'skill-one')!, 'skills-item-desc')!.textContent).toBe('skill-one desc')
    expect(cardFor(el, 'skill-two')).toBeTruthy()
    expect(q(cardFor(el, 'skill-two')!, 'skills-item-desc')).toBeNull()
  })
})
