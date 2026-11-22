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

/** Scenario tests for the Skills page: the 3a list column and its write paths (create, toggle, remove). */

/** The shared editor, reduced to a textarea plus its Save: Tiptap/Monaco do not run under jsdom. */
vi.mock('../editor/DocumentEditorPane', () => ({
  DocumentEditorPane: (p: {
    path: string
    value: string
    defaultMode?: string
    readOnly?: boolean
    dirty?: boolean
    onChange: (v: string) => void
    onSave?: () => void
  }) =>
    createElement('div', { 'data-testid': 'document-editor-pane', 'data-mode': p.defaultMode, 'data-dirty': String(!!p.dirty) }, [
      createElement('textarea', {
        key: 'ta',
        'data-testid': 'markdown-editor',
        readOnly: !!p.readOnly,
        value: p.value,
        onChange: (e: { target: { value: string } }) => p.onChange(e.target.value),
      }),
      p.onSave
        ? createElement('button', { key: 'save', type: 'button', 'data-testid': 'document-save', onClick: p.onSave }, 'Save')
        : null,
    ]),
}))

const HOME = '/home/bilko'
const SKILLS_DIR = `${HOME}/.claude/skills`
const COMMANDS_DIR = `${HOME}/.claude/commands`
const ONE = `${SKILLS_DIR}/skill-one/SKILL.md`
const TWO = `${SKILLS_DIR}/skill-two/SKILL.md`

const md = (name: string, extra: string[] = []) =>
  ['---', `name: ${name}`, `description: ${name} desc`, ...extra, '---', '', 'body'].join('\n')
const commandMd = (description: string) => ['---', `description: ${description}`, '---', '', 'body'].join('\n')

/** An installed plugin fixture: its skill folder names and command names live under `/plugins/<name>`. */
interface PluginFixture {
  name: string
  enabled?: boolean
  skills?: string[]
  commands?: string[]
  /** Every read under this plugin's install dir throws. */
  broken?: boolean
}
const pluginRoot = (name: string) => `/plugins/${name}`

/** `skills` are folder names under SKILLS_DIR; `commands` maps a command name to its description. */
function installApi({
  skills = ['skill-one', 'skill-two'],
  commands = {},
  plugins = [],
}: { skills?: string[]; commands?: Record<string, string>; plugins?: PluginFixture[] } = {}) {
  const disk: Record<string, string> = {}
  for (const n of skills) disk[`${SKILLS_DIR}/${n}/SKILL.md`] = md(n)
  for (const [n, description] of Object.entries(commands)) disk[`${COMMANDS_DIR}/${n}.md`] = commandMd(description)
  for (const p of plugins) {
    for (const n of p.skills ?? []) disk[`${pluginRoot(p.name)}/skills/${n}/SKILL.md`] = md(n)
    for (const n of p.commands ?? []) disk[`${pluginRoot(p.name)}/commands/${n}.md`] = commandMd(`${n} cmd`)
  }
  const pluginOf = (path: string) => plugins.find((p) => path === pluginRoot(p.name) || path.startsWith(`${pluginRoot(p.name)}/`))
  const assertReadable = (path: string) => {
    if (pluginOf(path)?.broken) throw new Error('EACCES: permission denied')
  }
  const entry = (name: string, path: string, isDirectory: boolean) =>
    ({ name, path, isDirectory, isFile: !isDirectory, mtimeMs: 0, size: 0 })
  const api = {
    app: { homeDir: vi.fn().mockResolvedValue(HOME) },
    plugins: {
      list: vi.fn(async () =>
        plugins.map((p) => ({
          key: `${p.name}@market`,
          name: p.name,
          marketplace: 'market',
          version: '1.0.0',
          scope: 'user',
          installPath: pluginRoot(p.name),
          enabled: p.enabled ?? true,
        }))
      ),
    },
    config: {
      exists: vi.fn(async (path: string) => {
        assertReadable(path)
        const p = pluginOf(path)
        return !!p && path === `${pluginRoot(p.name)}/skills` && (p.skills ?? []).length > 0
      }),
      readJson: vi.fn(async (path: string) => {
        assertReadable(path)
        return { exists: false, data: null, parseError: false, error: null }
      }),
      listDir: vi.fn(async (path: string, opts?: { dirsOnly?: boolean; filesOnly?: boolean }) => {
        assertReadable(path)
        if (path === SKILLS_DIR && opts?.dirsOnly) {
          return { ok: true, error: null, entries: skills.map((n) => entry(n, `${SKILLS_DIR}/${n}`, true)) }
        }
        if (path === COMMANDS_DIR && opts?.filesOnly) {
          return { ok: true, error: null, entries: Object.keys(commands).map((n) => entry(`${n}.md`, `${COMMANDS_DIR}/${n}.md`, false)) }
        }
        const p = pluginOf(path)
        if (p && path === `${pluginRoot(p.name)}/skills` && opts?.dirsOnly) {
          return { ok: true, error: null, entries: (p.skills ?? []).map((n) => entry(n, `${path}/${n}`, true)) }
        }
        if (p && path === `${pluginRoot(p.name)}/commands` && opts?.filesOnly) {
          return { ok: true, error: null, entries: (p.commands ?? []).map((n) => entry(`${n}.md`, `${path}/${n}.md`, false)) }
        }
        return { ok: true, error: null, entries: [] }
      }),
      readText: vi.fn(async (path: string) =>
        (assertReadable(path), path in disk)
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
/** The list's rows, in display order, and the `/name` each one shows (the row's first span). */
const cards = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="skills-item"]'))
const nameOf = (card: HTMLElement) => card.querySelector('[role="option"] span')?.textContent
const rowOf = (card: HTMLElement | undefined) => card?.querySelector<HTMLElement>('[role="option"]') ?? null
const isSelected = (card: HTMLElement | undefined) => rowOf(card)?.getAttribute('aria-selected') === 'true'
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
/** The `+ New` primary in the list toolbar. */
const newButton = (el: HTMLElement) => q(el, 'skills-new')!
/** React tracks a controlled input's value; go through the native setter so onChange fires. */
const typeFilter = async (el: HTMLElement, value: string) => {
  const input = q(el, 'skills-filter') as HTMLInputElement
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
    await click(q(el, 'skill-detail-more')!)
    await click(q(el, 'skill-detail-remove')!)
    expect(winConfirm).not.toHaveBeenCalled()
    expect(api.files.delete).not.toHaveBeenCalled()
    await click(buttonByText(el, 'confirm')!)
    expect(api.files.delete).toHaveBeenCalledWith(`${SKILLS_DIR}/skill-one`)
    expect(el.textContent).not.toContain('skill-one')
    expect(q(el, 'skill-detail')!.textContent).toContain('/skill-two')
    expect(useConfig.getState().files[TWO]).toBeDefined()
  })

  it('does nothing on cancel', async () => {
    const { api } = installApi()
    const el = await mount()
    await click(q(el, 'skill-detail-more')!)
    await click(q(el, 'skill-detail-remove')!)
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
  it('shows the SKILLS FOLDER card, Filter and a + New menu whose Browse catalog… opens the catalog', async () => {
    const { disk } = installApi({ skills: ['skill-one', 'skill-two'], commands: { deploy: 'Ship it', review: 'Review the diff' } })
    disk[TWO] = md('skill-two', ['disable-model-invocation: true'])
    const onAdd = vi.fn()
    const el = await mount({ onAdd })
    expect(q(el, 'config-workbench')).not.toBeNull()
    const card = q(el, 'config-file-card')!
    expect(card.textContent).toContain('SKILLS FOLDER')
    expect(q(card, 'skills-folder-on')!.textContent).toBe('1 on')
    expect(card.querySelector('.font-mono')!.textContent).toBe('~/.claude/skills/')
    expect(q(card, 'skills-folder-note')!.textContent).toBe('2 skills · on in every project')
    expect((q(el, 'skills-filter') as HTMLInputElement).placeholder).toBe('Filter')
    expect(buttonByText(el, 'Add…')).toBeUndefined()
    expect(newButton(el).textContent).toBe('+ New')
    await click(newButton(el))
    const browse = q(el, 'skills-new-browse-catalog')!
    expect(browse.textContent).toBe('Browse catalog…')
    await click(browse)
    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(q(el, 'skills-new-menu')).toBeNull()
  })

  it('offers Browse catalog… only when the page has a catalog to open', async () => {
    installApi()
    const el = await mount({ scope: 'user' })
    await click(newButton(el))
    expect(q(el, 'skills-new-menu')).not.toBeNull()
    expect(q(el, 'skills-new-browse-catalog')).toBeNull()
  })

  it('explains what a skill is when there are none, and Create a skill → starts New skill', async () => {
    installApi({ skills: [] })
    const onAdd = vi.fn()
    const el = await mount({ onAdd })
    const empty = q(el, 'skills-empty')!
    expect(empty.textContent).toContain('No skills yet')
    expect(empty.textContent).toContain('A skill is a folder with a SKILL.md that Claude loads when a task calls for it.')
    expect(classes(empty)).toEqual(expect.arrayContaining(['border-dashed', 'border-rule']))
    expect(q(el, 'skills-folder-on')!.textContent).toBe('0 on')
    expect(q(el, 'skills-folder-note')!.textContent).toBe('0 skills · on in every project')
    const link = q(el, 'skills-create-link')!
    expect(link.textContent).toBe('Create a skill →')
    await click(link)
    expect(onAdd).not.toHaveBeenCalled()
    const input = q(el, 'skills-new-name-skills') as HTMLInputElement
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('filters skills and commands by name or description, ignoring case', async () => {
    const { disk } = installApi({ commands: { 'refresh-claude-md': 'Audit and refresh CLAUDE.md files' } })
    disk[TWO] = md('skill-two').replace('skill-two desc', 'Deploys the Docs site')
    const el = await mount()
    expect(listed(el)).toEqual(['/skill-one', '/skill-two', '/refresh-claude-md'])

    await typeFilter(el, 'DOCS')
    expect(listed(el)).toEqual(['/skill-two'])
    expect(q(el, 'skills-section-commands-count')!.textContent).toBe('0')

    await typeFilter(el, 'claude.md')
    expect(listed(el)).toEqual(['/refresh-claude-md'])
    // Skills exist, they just do not match: no "No skills yet" explainer.
    expect(q(el, 'skills-empty')).toBeNull()

    await typeFilter(el, 'Skill-One')
    expect(listed(el)).toEqual(['/skill-one'])
    // The folder card counts everything, not just what the filter shows.
    expect(q(el, 'skills-folder-note')!.textContent).toBe('2 skills · on in every project')

    await typeFilter(el, '')
    expect(listed(el)).toHaveLength(3)
  })

  it('shows one row per item with the mono /name and its one-line description; a click selects it', async () => {
    installApi({ commands: { 'refresh-claude-md': 'Audit, refresh, and split CLAUDE.md files' } })
    const el = await mount()
    expect(q(el, 'skills-section-commands-count')!.textContent).toBe('1')
    const cmd = cardFor(el, 'refresh-claude-md')!
    expect(classes(cmd.querySelector('[role="option"] span'))).toContain('font-mono')
    expect(q(cmd, 'skills-item-desc')!.textContent).toBe('Audit, refresh, and split CLAUDE.md files')
    // Commands have no enable switch; skills do.
    expect(cmd.querySelector('[role="switch"]')).toBeNull()
    expect(toggleFor(el, 'skill-one')).not.toBeNull()

    // The first skill starts selected.
    expect(isSelected(cardFor(el, 'skill-one'))).toBe(true)
    expect(isSelected(cmd)).toBe(false)
    await click(q(cmd, 'skills-item-desc')!)
    expect(isSelected(cmd)).toBe(true)
    expect(isSelected(cardFor(el, 'skill-one'))).toBe(false)
    expect(q(el, 'config-detail-header')!.textContent).toContain('COMMAND · USER · ~/.claude/commands/refresh-claude-md.md')
  })

  it('shows the project skills folder under the cwd, on in this project', async () => {
    installApi({ skills: [] })
    useSessions.setState({ tabs: [{ id: 't1', cwd: '/work/proj' } as never], activeTabId: 't1' })
    const el = await mount({ scope: 'project' })
    expect(q(el, 'config-file-card')!.querySelector('.font-mono')!.textContent).toBe('/work/proj/.claude/skills/')
    expect(q(el, 'skills-folder-note')!.textContent).toBe('0 skills · on in this project')
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

describe('Skills detail (3a)', () => {
  const setValue = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
    })
  }

  const editor = (el: HTMLElement) => q(el, 'markdown-editor') as HTMLTextAreaElement

  it('shows the eyebrow path, the /name title, the Enabled switch, the ⋯ menu and the DESCRIPTION card', async () => {
    installApi()
    const el = await mount()
    const detail = q(el, 'skill-detail')!
    const header = q(detail, 'config-detail-header')!
    expect(header.textContent).toContain('SKILL · USER · ~/.claude/skills/skill-one/SKILL.md')
    expect(header.textContent).toContain('/skill-one')
    expect(q(detail, 'skill-detail-enabled')!.textContent).toContain('Enabled')
    expect(q(detail, 'skill-detail-enabled')!.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(q(detail, 'skill-detail-more')!.textContent).toBe('⋯')
    const card = q(detail, 'config-card')!
    expect(card.textContent).toContain('DESCRIPTION · CLAUDE READS THIS TO DECIDE WHEN TO USE IT')
    expect((q(card, 'skill-detail-description') as HTMLTextAreaElement).value).toBe('skill-one desc')
    // The body opens in the shared document editor, Document mode first, clean.
    const pane = q(detail, 'document-editor-pane')!
    expect(pane.getAttribute('data-mode')).toBe('document')
    expect(pane.getAttribute('data-dirty')).toBe('false')
  })

  it('the detail Enabled switch writes disable-model-invocation, like the row switch', async () => {
    const { disk } = installApi()
    const el = await mount()
    await click(q(el, 'skill-detail-enabled')!.querySelector('[role="switch"]')!)
    expect(disk[ONE]).toContain('disable-model-invocation: true')
    expect(toggleFor(el, 'skill-one').getAttribute('aria-checked')).toBe('false')
  })

  it('⋯ › Reveal in File Explorer opens the File Explorer on the file', async () => {
    installApi()
    const el = await mount()
    const openPanel = vi.fn()
    useLayout.setState({ openPanel } as never)
    await click(q(el, 'skill-detail-more')!)
    await click(q(el, 'skill-detail-reveal')!)
    expect(openPanel).toHaveBeenCalledWith('projects', `reveal:${ONE}`)
  })

  it('edits only the body, and saves the description edit keeping the rest byte-for-byte', async () => {
    const { disk } = installApi()
    const el = await mount()
    expect(editor(el).value).toBe('\nbody')
    await setValue(q(el, 'skill-detail-description') as HTMLTextAreaElement, 'Does: things')
    await setValue(editor(el), '\nnew body')
    expect(q(el, 'document-editor-pane')!.getAttribute('data-dirty')).toBe('true')
    await click(q(el, 'document-save')!)
    expect(disk[ONE]).toBe(['---', 'name: skill-one', 'description: "Does: things"', '---', '', 'new body'].join('\n'))
    expect(q(el, 'document-editor-pane')!.getAttribute('data-dirty')).toBe('false')
  })

  it('saving a body edit keeps the frontmatter exactly as it was on disk', async () => {
    const { disk } = installApi()
    // Odd-but-valid frontmatter: comments, key order, quoting, a block scalar, CRLF-free spacing.
    const frontmatter = [
      '---',
      '# keep me',
      "description:   'Use when: a task  needs it'   # trailing",
      'name: skill-one',
      'allowed-tools:',
      '  - Bash',
      'notes: |',
      '  line one',
      '    indented',
      '---',
      '',
    ].join('\n')
    disk[ONE] = `${frontmatter}old body\n`
    const el = await mount()
    expect(editor(el).value).toBe('old body\n')
    await setValue(editor(el), '# Rewritten\n\nnew body\n')
    await click(q(el, 'document-save')!)
    expect(disk[ONE]).toBe(`${frontmatter}# Rewritten\n\nnew body\n`)
    expect(disk[ONE].startsWith(frontmatter)).toBe(true)
  })

  it('shows a failed save inline', async () => {
    const { api } = installApi()
    const el = await mount()
    await setValue(editor(el), 'changed')
    api.config.writeText.mockResolvedValueOnce({ ok: false, error: 'EROFS' } as never)
    await click(q(el, 'document-save')!)
    expect(q(el, 'skill-detail-save-error')?.textContent).toContain('EROFS')
  })
})

describe('Skills create (+ New)', () => {
  const PROJECT = '/work/proj'
  const setNative = (input: HTMLInputElement, value: string) =>
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  const typeName = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      setNative(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const press = async (input: HTMLElement, key: string) => {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      await flush()
      await flush()
    })
  }
  const pickNew = async (el: HTMLElement, id: 'skills-new-skill' | 'skills-new-command') => {
    await click(newButton(el))
    await click(q(el, id)!)
  }
  const selectedName = (el: HTMLElement) => cards(el).filter(isSelected).map(nameOf)

  it('the + New menu offers New skill, New command and Browse catalog…', async () => {
    installApi()
    const el = await mount({ onAdd: vi.fn() })
    await click(newButton(el))
    const labels = Array.from(q(el, 'skills-new-menu')!.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)
    expect(labels).toEqual(['New skill', 'New command', 'Browse catalog…'])
  })

  it('creates a skill in the user scope, selects it and focuses its Description', async () => {
    const { api, disk } = installApi()
    const el = await mount()
    await pickNew(el, 'skills-new-skill')
    const input = q(el, 'skills-new-name-skills') as HTMLInputElement
    // Inline at the top of the skills rows, before the first one.
    expect(q(el, 'skills-list')!.firstElementChild).toBe(q(el, 'skills-new-row-skills'))
    expect(document.activeElement).toBe(input)
    await typeName(input, 'my-skill')
    await press(input, 'Enter')
    const path = `${SKILLS_DIR}/my-skill/SKILL.md`
    expect(api.config.writeText).toHaveBeenCalledTimes(1)
    expect(disk[path]).toBe(['---', 'name: my-skill', 'description: ""', '---', '', '# my-skill', ''].join('\n'))
    expect(q(el, 'skills-new-name-skills')).toBeNull()
    expect(selectedName(el)).toEqual(['/my-skill'])
    expect(q(el, 'config-detail-header')!.textContent).toContain('/my-skill')
    expect(document.activeElement).toBe(q(el, 'skill-detail-description'))
  })

  it('creates a command under the project scope root', async () => {
    const { api, disk } = installApi({ skills: [] })
    useSessions.setState({ tabs: [{ id: 't1', cwd: PROJECT } as never], activeTabId: 't1' })
    const el = await mount({ scope: 'project' })
    await pickNew(el, 'skills-new-command')
    const input = q(el, 'skills-new-name-commands') as HTMLInputElement
    expect(q(el, 'skills-section-commands')!.nextElementSibling).toBe(q(el, 'skills-new-row-commands'))
    await typeName(input, 'deploy')
    await press(input, 'Enter')
    const path = `${PROJECT}/.claude/commands/deploy.md`
    expect(api.config.writeText).toHaveBeenCalledWith(path, ['---', 'description: ""', '---', ''].join('\n'))
    expect(disk[path]).toBeDefined()
    expect(selectedName(el)).toEqual(['/deploy'])
    expect(document.activeElement).toBe(q(el, 'skill-detail-description'))
  })

  it('rejects an invalid name inline and never writes; Escape cancels', async () => {
    const { api } = installApi()
    const el = await mount()
    await pickNew(el, 'skills-new-skill')
    const input = q(el, 'skills-new-name-skills') as HTMLInputElement
    for (const bad of ['My Skill', '-lead', 'a'.repeat(65), 'a_b']) {
      await typeName(input, bad)
      await press(input, 'Enter')
      expect(q(el, 'skills-new-error-skills')!.textContent).toMatch(/lowercase/i)
    }
    expect(api.config.writeText).not.toHaveBeenCalled()
    await press(input, 'Escape')
    expect(q(el, 'skills-new-name-skills')).toBeNull()
    expect(api.config.writeText).not.toHaveBeenCalled()
  })

  it('rejects a name that collides with an existing item', async () => {
    const { api } = installApi({ commands: { deploy: 'Ship it' } })
    const el = await mount()
    await pickNew(el, 'skills-new-skill')
    const skillInput = q(el, 'skills-new-name-skills') as HTMLInputElement
    await typeName(skillInput, 'skill-one')
    await press(skillInput, 'Enter')
    expect(q(el, 'skills-new-error-skills')!.textContent).toMatch(/already exists/i)
    await press(skillInput, 'Escape')
    await pickNew(el, 'skills-new-command')
    const cmdInput = q(el, 'skills-new-name-commands') as HTMLInputElement
    await typeName(cmdInput, 'deploy')
    await press(cmdInput, 'Enter')
    expect(q(el, 'skills-new-error-commands')!.textContent).toMatch(/already exists/i)
    expect(api.config.writeText).not.toHaveBeenCalled()
  })

  it('toasts the write failure and leaves nothing selected', async () => {
    const { api } = installApi()
    api.config.writeText.mockResolvedValueOnce({ ok: false, error: 'EACCES: permission denied' } as never)
    const err = vi.spyOn(toast, 'error').mockImplementation(() => '')
    const el = await mount()
    await pickNew(el, 'skills-new-skill')
    const input = q(el, 'skills-new-name-skills') as HTMLInputElement
    await typeName(input, 'my-skill')
    await press(input, 'Enter')
    expect(err).toHaveBeenCalledWith(expect.stringContaining('EACCES: permission denied'))
    expect(selectedName(el)).toEqual([])
    expect(listed(el)).not.toContain('/my-skill')
    expect(q(el, 'skill-detail')).toBeNull()
  })
})

describe('Skills FROM PLUGINS (3a)', () => {
  const STRIPE: PluginFixture = { name: 'stripe', skills: ['checkout', 'billing', 'connect'], commands: ['stripe-login', 'test-cards'] }
  const DEV: PluginFixture = { name: 'session-manager-dev', skills: ['develop'] }
  const OFF: PluginFixture = { name: 'disabled-one', enabled: false, skills: ['nope'] }
  const groupRows = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('[data-testid="plugin-skills-row"]'))
  const rowFor = (el: HTMLElement, name: string) => groupRows(el).find((r) => r.getAttribute('data-plugin') === name)
  const pluginItems = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLElement>('[data-testid="plugin-skills-item"]')).map((i) => q(i, 'plugin-skills-item-name')?.textContent)

  it('lists one row per enabled plugin with its counts (zero parts omitted), a READ-ONLY badge and the total', async () => {
    installApi({ plugins: [STRIPE, DEV, OFF] })
    const el = await mount()
    const header = q(el, 'skills-section-plugins')!
    expect(header.textContent).toContain('From plugins')
    expect(q(header, 'skills-section-plugins-count')?.textContent).toBe('6')
    expect(q(header, 'skills-section-plugins-readonly')?.textContent).toBe('READ-ONLY')
    expect(groupRows(el).map((r) => r.getAttribute('data-plugin'))).toEqual(['session-manager-dev', 'stripe'])
    expect(q(rowFor(el, 'stripe')!, 'plugin-skills-row-counts')?.textContent).toBe('3 skills · 2 commands')
    expect(q(rowFor(el, 'session-manager-dev')!, 'plugin-skills-row-counts')?.textContent).toBe('1 skill')
    expect(rowFor(el, 'stripe')!.querySelector('svg')).not.toBeNull()
    // Collapsed by default; plugin items never show up as editable cards.
    expect(pluginItems(el)).toEqual([])
    expect(listed(el)).toEqual(['/skill-one', '/skill-two'])
  })

  it('expands a plugin row to its skills and commands and opens one read-only', async () => {
    const { api } = installApi({ plugins: [STRIPE] })
    const el = await mount()
    await click(rowFor(el, 'stripe')!)
    expect(rowFor(el, 'stripe')!.getAttribute('aria-expanded')).toBe('true')
    expect(pluginItems(el)).toEqual(['/billing', '/checkout', '/connect', '/stripe-login', '/test-cards'])
    const checkout = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="plugin-skills-item"]'))[1]
    await click(checkout)
    const detail = q(el, 'skill-detail')!
    const header = q(detail, 'config-detail-header')!
    expect(header.textContent).toContain('SKILL · FROM STRIPE · /plugins/stripe/skills/checkout/SKILL.md')
    expect(header.textContent).toContain('/checkout')
    expect(q(detail, 'skill-detail-readonly')?.textContent).toBe('Read-only')
    expect(q(detail, 'skill-detail-enabled')).toBeNull()
    expect((q(detail, 'markdown-editor') as HTMLTextAreaElement).readOnly).toBe(true)
    expect(q(detail, 'document-editor-pane')!.getAttribute('data-mode')).toBe('document')
    expect(q(detail, 'skill-detail-description')).toBeNull()
    expect(q(detail, 'skill-detail-description-text')?.textContent).toBe('checkout desc')
    expect(q(detail, 'document-save')).toBeNull()
    await click(q(detail, 'skill-detail-more')!)
    expect(q(detail, 'skill-detail-reveal')).not.toBeNull()
    expect(q(detail, 'skill-detail-remove')).toBeNull()
    expect(api.config.writeText).not.toHaveBeenCalled()

    // A command opens as COMMAND, still read-only.
    const login = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="plugin-skills-item"]'))[3]
    await click(login)
    expect(q(el, 'config-detail-header')!.textContent).toContain('COMMAND · FROM STRIPE')
    expect(q(el, 'skill-detail-description-text')?.textContent).toBe('stripe-login cmd')
  })

  it('the filter also matches plugin items, showing the matching ones', async () => {
    installApi({ plugins: [STRIPE, DEV] })
    const el = await mount()
    await typeFilter(el, 'connect')
    expect(groupRows(el).map((r) => r.getAttribute('data-plugin'))).toEqual(['stripe'])
    expect(pluginItems(el)).toEqual(['/connect'])
    expect(q(el, 'skills-section-plugins-count')?.textContent).toBe('1')
    expect(listed(el)).toEqual([])
  })

  it('shows a failing plugin as a row with an error note and keeps the rest of the list', async () => {
    installApi({ plugins: [STRIPE, { name: 'broken', broken: true, skills: ['x'] }] })
    const el = await mount()
    const broken = rowFor(el, 'broken')!
    expect(q(broken, 'plugin-skills-row-error')?.textContent).toBe('Could not read plugin')
    expect(q(broken, 'plugin-skills-row-error')?.getAttribute('title')).toContain('EACCES')
    expect(q(rowFor(el, 'stripe')!, 'plugin-skills-row-counts')?.textContent).toBe('3 skills · 2 commands')
    expect(listed(el)).toEqual(['/skill-one', '/skill-two'])
  })

  it('loads plugin data once per mount and again on config.onChanged for the plugin sources', async () => {
    const { api } = installApi({ plugins: [STRIPE] })
    const el = await mount()
    expect(api.plugins.list).toHaveBeenCalledTimes(1)
    const emit = (path: string) =>
      (api.config.onChanged.mock.calls as unknown as Array<[(i: { path: string }) => void]>).forEach(([cb]) => cb({ path }))
    api.plugins.list.mockResolvedValueOnce([])
    await act(async () => {
      emit(`${HOME}/.claude/plugins/installed_plugins.json`)
      await flush()
      await flush()
    })
    expect(api.plugins.list).toHaveBeenCalledTimes(2)
    expect(groupRows(el)).toEqual([])
  })

  it('has no FROM PLUGINS section in project scope', async () => {
    const { api } = installApi({ plugins: [STRIPE] })
    useSessions.setState({ tabs: [{ id: 't1', cwd: '/work/proj' }] as never, activeTabId: 't1' })
    const el = await mount({ scope: 'project' })
    expect(q(el, 'skills-section-plugins')).toBeNull()
    expect(api.plugins.list).not.toHaveBeenCalled()
  })
})
