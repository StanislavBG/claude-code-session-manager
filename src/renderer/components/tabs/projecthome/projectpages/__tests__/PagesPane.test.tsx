// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EXTRA_INSTRUCTIONS_CAP, PagesPane, fitInstructions, type PagesPaneProps } from '../PagesPane'
import { BUILDING_ROW_ID, type BuildLaunch } from '../BuildingPanel'
import { ProjectHome } from '../../ProjectHome'
import { useToast } from '../../../../../state/toast'
import { useSessions } from '../../../../../state/sessions'
import { __resetMacrosCacheForTests } from '../../../../../lib/useMacros'
import type { ProjectKnowledgeEntry } from '../../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus } from '../../../../../../preload/api'

// ProjectHome's launches go through this spy instead of the real dispatch path (only ProjectHome imports it).
const launchSpy = vi.hoisted(() => vi.fn())
vi.mock('../../../../../lib/useMacroLaunch', () => ({
  useMacroLaunch: () => ({ launch: launchSpy, launching: null, cwd: '/proj' }),
}))

const HTML = '<!DOCTYPE html><html><body>PAGE</body></html>'
const HOUR = 3_600_000
const DAY = 24 * HOUR

const readText = vi.fn()
const rename = vi.fn()
const del = vi.fn()

beforeEach(() => {
  readText.mockReset().mockResolvedValue({ exists: true, text: HTML, mtimeMs: 1, error: null, truncated: false })
  rename.mockReset().mockResolvedValue({ ok: true, title: 'x' })
  del.mockReset().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = { config: { readText }, projectPages: { rename, delete: del } }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const HOME: Macro = {
  id: 'builtin-project-home',
  label: 'Project Home',
  agentName: 'project-home-builder',
  tag: 'project-home-builder',
  prompt: 'Generate it.',
  projects: ['*'],
  surface: 'project-home',
  createdAt: '',
  updatedAt: '',
}

function page(id: string, title: string, agoMs: number, topic = ''): ProjectKnowledgeEntry {
  const t = Date.now() - agoMs
  return {
    id,
    path: `/proj/knowledge/${id}/index.html`,
    mtimeMs: t,
    error: null,
    meta: { id, title, topic, createdAt: new Date(t).toISOString(), model: 'sonnet' },
  }
}

const OVERVIEW = page('overview', 'Overview', DAY + HOUR)
const HOW = page('how-it-works', 'How it works', 3 * DAY + HOUR)
const FAQ = page('faq', 'FAQ', 5 * DAY + HOUR)
const TOPIC = page('billing-flow', 'Billing flow', 6 * DAY + HOUR, 'Billing flow')
const ENTRIES = [OVERVIEW, HOW, FAQ, TOPIC]

/** The Overview template's default prompt lines, joined. */
const OVERVIEW_LINES = 'Page: Overview\nAudience: Newcomers\nLength: Standard\nRead from: README & docs, Source tree, Git log'

function props(over: Partial<PagesPaneProps> = {}): PagesPaneProps {
  return { cwd: '/proj', entries: ENTRIES, macro: HOME, launching: null, onLaunch: vi.fn(), ...over }
}

function mount(over: Partial<PagesPaneProps> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<PagesPane {...props(over)} />))
  return container
}
const rerender = (over: Partial<PagesPaneProps>) => act(() => root!.render(<PagesPane {...props(over)} />))
const flush = () => act(async () => { await Promise.resolve() })

/** The composer portals into document.body, so every lookup searches the whole document. */
const tid = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="knowledge-page-item"]'))
const items = () => Array.from(container!.querySelectorAll<HTMLElement>('li'))
const col = (row: HTMLElement, name: string) => row.querySelector(`[data-col="${name}"]`)?.textContent
const click = (el: HTMLElement | null) => act(() => el!.click())
function type(el: HTMLElement | null, value: string) {
  const field = el as HTMLInputElement | HTMLTextAreaElement
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    set.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (el: HTMLElement | null, key: string) =>
  act(async () => {
    el!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await Promise.resolve()
  })
const status = (over: Partial<MacroJobStatus>): MacroJobStatus => ({
  macroId: 'builtin-project-home',
  epicId: 'epic-1',
  slug: 's',
  state: 'queued',
  status: 'queued',
  reason: null,
  startedAt: null,
  finishedAt: null,
  ...over,
})
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()
const texts = (id: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll(`[data-testid="${id}"]`)).map((n) => n.textContent)
const ids = () => rows().map((r) => r.getAttribute('data-id'))
const current = () => rows().map((r) => r.getAttribute('aria-current'))

/** This window's last launch of the Getting started template (a custom topic), as ProjectHome keeps it. */
const NEW_LAUNCH: BuildLaunch = {
  title: 'Getting started',
  lines: [
    'Page: Custom topic: Getting started: install, first run, key commands',
    'Audience: Newcomers',
    'Length: Brief',
    'Read from: README & docs, Source tree',
  ],
  at: Date.now() - 5_000,
}
/** This window's last Regenerate… of How it works. */
const REGEN_LAUNCH: BuildLaunch = {
  title: 'How it works',
  lines: [
    'Page: How it works',
    'Audience: Contributors',
    'Length: In-depth',
    'Read from: README & docs, Source tree',
    'Replace entry: how-it-works',
  ],
  replaceEntryId: 'how-it-works',
  at: Date.now() - 5_000,
}

describe('PagesPane list column', () => {
  it('lists every entry with its title and "<kind> · <ago>" under KNOWLEDGE PAGES and the count', async () => {
    mount()
    await flush()
    expect(tid('project-home-pages-header')?.textContent).toContain('KNOWLEDGE PAGES')
    expect(tid('project-home-pages-count')?.textContent).toBe('4')
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual(['overview', 'how-it-works', 'faq', 'billing-flow'])
    expect(rows().map((r) => [col(r, 'title'), col(r, 'meta')])).toEqual([
      ['Overview', 'overview · 1d ago'],
      ['How it works', 'how it works · 3d ago'],
      ['FAQ', 'faq · 5d ago'],
      ['Billing flow', 'custom topic · 6d ago'],
    ])
  })

  it('puts a full-width accent Generate page button above the list', () => {
    mount()
    const btn = tid('project-home-generate') as HTMLButtonElement
    expect(btn.getAttribute('data-kind')).toBe('page')
    expect(btn.textContent).toBe('Generate page')
    expect(btn.className).toContain('w-full')
    expect(btn.className).toContain('bg-accent')
    expect(btn.disabled).toBe(false)
    expect(btn.compareDocumentPosition(tid('project-home-pages-header')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows an unreadable entry as its id and error, still with its kind and age', () => {
    const broken: ProjectKnowledgeEntry = { id: 'faq', path: '/proj/knowledge/faq/index.html', mtimeMs: Date.now() - 2 * HOUR, error: 'meta.json missing', meta: null }
    mount({ entries: [broken] })
    expect(col(rows()[0], 'title')).toBe('faq: meta.json missing')
    expect(col(rows()[0], 'meta')).toBe('faq · 2h ago')
    expect(tid('project-home-page-title')?.textContent).toBe('faq')
    expect(tid('project-home-page-sub')?.textContent).toBe('FAQ · 2h ago')
  })

  it('with no entries keeps the knowledge-page-empty element: the starter gallery, whose Overview Generate launches', () => {
    const onLaunch = vi.fn()
    const el = mount({ entries: [], onLaunch })
    const empty = tid('knowledge-page-empty', el)!
    expect(tid('library-empty-eyebrow', empty)?.textContent).toBe('NO PAGES YET')
    expect(tid('project-home-library')).toBeNull()
    expect(tid('project-home-regenerate')).toBeNull()
    expect(tid('project-home-generate')).toBeNull()
    click(tid('template-card-quick', empty.querySelector('[data-tpl="overview"]')!))
    expect(tid('project-home-composer')).toBeNull()
    expect(onLaunch.mock.calls).toEqual([[HOME, OVERVIEW_LINES]])
  })

  it('an open composer keeps its form when the first page lands under it', async () => {
    const onLaunch = vi.fn()
    mount({ entries: [], onLaunch })
    click(tid('template-card-customize', document.querySelector('[data-testid="template-card"][data-tpl="overview"]')!))
    type(tid('composer-focus'), 'keep me')
    rerender({ entries: [OVERVIEW], onLaunch })
    await flush()
    expect(tid('project-home-library')).not.toBeNull()
    expect((tid('composer-focus') as HTMLTextAreaElement).value).toBe('keep me')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[HOME, `${OVERVIEW_LINES}\nkeep me`]])
  })
})

describe('PagesPane selection and content column', () => {
  it('selects the first entry by default: aria-current, serif title bar and the page in HtmlFrame', async () => {
    mount()
    await flush()
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual(['true', null, null, null])
    const title = tid('project-home-page-title')!
    expect(title.textContent).toBe('Overview')
    expect(title.className).toContain('font-serif')
    const sub = tid('project-home-page-sub')!
    expect(sub.textContent).toBe('Overview · sonnet · 1d ago')
    expect(sub.className).toContain('font-mono')
    expect(tid('project-home-regenerate')?.textContent).toBe('Regenerate…')
    expect(tid('project-home-content')?.querySelector('iframe[title="Overview"]')?.getAttribute('srcdoc')).toBe(HTML)
    expect(readText).toHaveBeenCalledWith('/proj/knowledge/overview/index.html')
  })

  it('a click selects another row and swaps the title bar and the frame', async () => {
    mount()
    await flush()
    click(rows()[3])
    await flush()
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual([null, null, null, 'true'])
    expect(tid('project-home-page-title')?.textContent).toBe('Billing flow')
    expect(tid('project-home-page-sub')?.textContent).toBe('Custom topic · sonnet · 6d ago')
    expect(document.querySelector('iframe[title="Billing flow"]')?.getAttribute('srcdoc')).toBe(HTML)
    click(rows()[1])
    await flush()
    expect(tid('project-home-page-sub')?.textContent).toBe('How it works · sonnet · 3d ago')
  })

  it('keeps the pick across list refreshes and falls back to the first entry once it is gone', async () => {
    mount()
    click(rows()[1])
    rerender({ entries: [page('newest', 'Newest', HOUR, 'Newest'), ...ENTRIES] })
    await flush()
    expect(tid('project-home-page-title')?.textContent).toBe('How it works')
    rerender({ entries: [FAQ, OVERVIEW] })
    await flush()
    expect(tid('project-home-page-title')?.textContent).toBe('FAQ')
  })

  it('follows a controlled selectedId and reports picks through onSelect', () => {
    const onSelect = vi.fn()
    mount({ selectedId: 'faq', onSelect })
    expect(rows()[2].getAttribute('aria-current')).toBe('true')
    click(rows()[0])
    expect(onSelect).toHaveBeenCalledWith('overview')
    expect(rows()[2].getAttribute('aria-current')).toBe('true')
  })
})

describe('PagesPane Generate and Regenerate', () => {
  it('Generate page opens the composer on its templates and launches builtin-project-home with the lines', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    expect(tid('project-home-composer')).toBeNull()
    click(tid('project-home-generate'))
    expect(tid('composer-title')?.textContent).toBe('Generate page')
    expect(document.querySelectorAll('[data-testid="composer-template"]').length).toBeGreaterThan(0)
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[HOME, OVERVIEW_LINES]])
    expect(tid('project-home-composer')).toBeNull()
  })

  it('sends the picked template and the Focus text as lines joined with a newline', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(tid('project-home-generate'))
    click(document.querySelector<HTMLElement>('[data-testid="composer-template"][data-tpl="faq"]'))
    type(tid('composer-focus'), 'Eight questions max')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[HOME, 'Page: FAQ\nAudience: Newcomers\nLength: Brief\nRead from: README & docs\nEight questions max']])
  })

  it('Regenerate… opens the composer pre-filled from the entry and appends Replace entry as the last line', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(rows()[1])
    click(tid('project-home-regenerate'))
    expect(tid('composer-title')?.textContent).toBe('Regenerate “How it works”')
    expect(tid('composer-eyebrow')?.textContent).toBe('REBUILDING · how-it-works')
    expect(tid('composer-template')).toBeNull()
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([
      [HOME, 'Page: How it works\nAudience: Contributors\nLength: In-depth\nRead from: README & docs, Source tree\nReplace entry: how-it-works'],
    ])
    expect(tid('project-home-composer')).toBeNull()
  })

  it('Regenerate… of a custom-topic page carries its meta.topic', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(rows()[3])
    click(tid('project-home-regenerate'))
    expect((tid('composer-topic') as HTMLInputElement).value).toBe('Billing flow')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([
      [HOME, 'Page: Custom topic: Billing flow\nAudience: Users\nLength: Standard\nRead from: README & docs, Source tree, Git log\nReplace entry: billing-flow'],
    ])
  })

  it('Cancel closes the composer without launching', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(tid('project-home-regenerate'))
    click(tid('composer-cancel'))
    expect(tid('project-home-composer')).toBeNull()
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('cuts an over-long Focus so the instructions fit the IPC cap, keeping Replace entry last', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(tid('project-home-regenerate'))
    type(tid('composer-focus'), 'x'.repeat(5000))
    click(tid('composer-generate'))
    const tail = '\nReplace entry: overview'
    const room = EXTRA_INSTRUCTIONS_CAP - OVERVIEW_LINES.length - tail.length - 1
    expect(onLaunch.mock.calls).toEqual([[HOME, `${OVERVIEW_LINES}\n${'x'.repeat(room)}${tail}`]])
    expect((onLaunch.mock.calls[0][1] as string).length).toBe(EXTRA_INSTRUCTIONS_CAP)
  })

  it('records each launch through onLaunched: the template name or custom topic as title, the sent lines, the entry it replaces', () => {
    const onLaunched = vi.fn()
    mount({ onLaunched })
    click(tid('project-home-generate'))
    click(tid('composer-generate'))
    click(tid('project-home-generate'))
    click(document.querySelector<HTMLElement>('[data-testid="composer-template"][data-tpl="start"]'))
    click(tid('composer-generate'))
    click(rows()[1])
    click(tid('project-home-regenerate'))
    click(tid('composer-generate'))
    expect(onLaunched.mock.calls).toEqual([
      ['builtin-project-home', { title: 'Overview', lines: OVERVIEW_LINES.split('\n'), at: expect.any(Number) }],
      ['builtin-project-home', { ...NEW_LAUNCH, at: expect.any(Number) }],
      ['builtin-project-home', { ...REGEN_LAUNCH, at: expect.any(Number) }],
    ])
  })

  it('done: both buttons enabled, no building row and no status line under Generate', () => {
    mount({ jobStatus: status({ state: 'done', status: 'completed', finishedAt: isoAgo(60_000) }), lastLaunch: NEW_LAUNCH })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(false)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(false)
    expect(ids()).toEqual(['overview', 'how-it-works', 'faq', 'billing-flow'])
    expect(tid('project-home-building-row')).toBeNull()
    expect(tid('project-home-building')).toBeNull()
    expect(tid('project-home-job-status')).toBeNull()
  })

  it('disables both buttons while any macro launches, labelling its own launch Starting…', () => {
    mount({ launching: 'builtin-project-home' })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('project-home-generate')?.textContent).toBe('Starting…')
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
    rerender({ launching: 'some-tool' })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('project-home-generate')?.textContent).toBe('Generate page')
  })

  it('without the builtin-project-home macro both buttons stay disabled', () => {
    mount({ macro: undefined })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('PagesPane competitive-matrix entry', () => {
  const MATRIX = page('competitive-matrix', 'Competitor matrix', HOUR)

  it('shows Update in Tools instead of Regenerate… and the button calls onGoTools', async () => {
    const onGoTools = vi.fn()
    mount({ entries: [MATRIX, ...ENTRIES], onGoTools })
    await flush()
    expect(tid('project-home-page-title')?.textContent).toBe('Competitor matrix')
    expect(tid('project-home-regenerate')).toBeNull()
    const btn = tid('project-home-update-in-tools') as HTMLButtonElement
    expect(btn.textContent).toBe('Update in Tools')
    expect(btn.disabled).toBe(false)
    click(btn)
    expect(onGoTools).toHaveBeenCalledTimes(1)
    expect(tid('composer-title')).toBeNull()
  })

  it('every other entry keeps Regenerate… and shows no Update in Tools', async () => {
    mount({ entries: [MATRIX, ...ENTRIES], onGoTools: vi.fn() })
    await flush()
    for (const r of rows().slice(1)) {
      click(r)
      expect(tid('project-home-regenerate')?.textContent).toBe('Regenerate…')
      expect(tid('project-home-update-in-tools')).toBeNull()
    }
  })

  it('without onGoTools the Update in Tools button is disabled', async () => {
    mount({ entries: [MATRIX] })
    await flush()
    expect((tid('project-home-update-in-tools') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('project-home-regenerate')).toBeNull()
  })
})

describe('PagesPane rename and delete', () => {
  it('shows Rename and Delete only under the selected row', () => {
    mount()
    expect(document.querySelectorAll('[data-testid="entry-rename"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-testid="entry-delete"]')).toHaveLength(1)
    expect(tid('entry-rename', items()[0])?.textContent).toBe('Rename')
    expect(tid('entry-delete', items()[0])?.textContent).toBe('Delete')
    click(rows()[2])
    expect(tid('entry-rename', items()[0])).toBeNull()
    expect(tid('entry-rename', items()[2])).not.toBeNull()
    expect(tid('entry-delete', items()[2])).not.toBeNull()
  })

  it('Rename swaps the row for an input: Enter saves via projectPages.rename, Escape cancels', async () => {
    mount()
    click(rows()[1])
    click(tid('entry-rename', items()[1]))
    const input = tid('entry-rename-input', items()[1]) as HTMLInputElement
    expect(input.value).toBe('How it works')
    expect(tid('knowledge-page-item', items()[1])).toBeNull()
    type(input, '  Architecture  ')
    await press(input, 'Enter')
    expect(rename).toHaveBeenCalledWith('/proj', 'knowledge', 'how-it-works', 'Architecture')
    expect(tid('entry-rename-input')).toBeNull()
    click(tid('entry-rename', items()[1]))
    await press(tid('entry-rename-input'), 'Escape')
    expect(tid('entry-rename-input')).toBeNull()
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('Delete asks "Delete this page?" inline; Cancel keeps the page, Confirm calls projectPages.delete', async () => {
    mount()
    click(tid('entry-delete', items()[0]))
    expect(items()[0].textContent).toContain('Delete this page?')
    expect(tid('entry-rename', items()[0])).toBeNull()
    click(tid('entry-delete-cancel', items()[0]))
    expect(del).not.toHaveBeenCalled()
    expect(tid('entry-delete', items()[0])).not.toBeNull()
    click(tid('entry-delete', items()[0]))
    await act(async () => {
      tid('entry-delete-confirm', items()[0])!.click()
      await Promise.resolve()
    })
    expect(del).toHaveBeenCalledWith('/proj', 'knowledge', 'overview')
  })

  it('selecting another row drops a pending delete question', () => {
    mount()
    click(tid('entry-delete', items()[0]))
    click(rows()[1])
    click(rows()[0])
    expect(items()[0].textContent).not.toContain('Delete this page?')
    expect(tid('entry-delete', items()[0])).not.toBeNull()
  })

  it('rename and delete failures surface as error toasts', async () => {
    rename.mockRejectedValue(new Error('meta.json invalid'))
    del.mockRejectedValue(new Error('entry not found'))
    mount()
    click(tid('entry-rename', items()[0]))
    type(tid('entry-rename-input', items()[0]), 'New')
    await press(tid('entry-rename-input', items()[0]), 'Enter')
    // The failed rename keeps row 0's input open, so pick the next row by id, not by button index.
    click(document.querySelector<HTMLElement>('[data-testid="knowledge-page-item"][data-id="how-it-works"]'))
    click(tid('entry-delete', items()[1]))
    await act(async () => {
      tid('entry-delete-confirm', items()[1])!.click()
      await Promise.resolve()
    })
    expect(useToast.getState().toasts.map((t) => [t.kind, t.message])).toEqual([
      ['error', 'Rename failed: meta.json invalid'],
      ['error', 'Delete failed: entry not found'],
    ])
  })

  it('shows no actions without a cwd', () => {
    mount({ cwd: null })
    expect(tid('entry-rename')).toBeNull()
    expect(tid('entry-delete')).toBeNull()
  })
})

describe('PagesPane build state', () => {
  it.each([
    ['queued', 'pending', null, 'Queued', 'Waiting to start'],
    ['running', 'running', 60_000, 'Building… started 1m ago', 'Started 1m ago'],
  ] as const)('%s: a selected building row on top, the BuildingPanel with the sent lines, Open session in the title bar', (state, raw, startedMs, meta, elapsed) => {
    const onOpenSession = vi.fn()
    mount({
      jobStatus: status({ state, status: raw, startedAt: startedMs === null ? null : isoAgo(startedMs) }),
      lastLaunch: NEW_LAUNCH,
      onOpenSession,
    })
    expect(ids()).toEqual([BUILDING_ROW_ID, 'overview', 'how-it-works', 'faq', 'billing-flow'])
    expect(current()).toEqual(['true', null, null, null, null])
    expect(tid('project-home-pages-count')?.textContent).toBe('5')
    const row = tid('project-home-building-row', rows()[0])!
    expect(row.getAttribute('data-state')).toBe(state)
    expect(col(row, 'title')).toBe('Getting started')
    expect(col(row, 'meta')).toBe(meta)
    expect(row.querySelector('[data-col="meta"]')?.className).toContain('text-accent-dark')
    expect(tid('project-home-building-bar', row)?.className).toContain('h-[3px]')
    // Rename · Delete sit under the selected, non-building row only.
    expect(tid('entry-rename')).toBeNull()
    expect(tid('project-home-page-title')?.textContent).toBe('Getting started')
    expect(tid('project-home-page-sub')?.textContent).toBe('Custom topic · newcomers · brief')
    expect(tid('project-home-regenerate')).toBeNull()
    const panel = tid('project-home-building', tid('project-home-content')!)!
    expect(panel.getAttribute('data-state')).toBe(state)
    expect(tid('project-home-building-title', panel)?.textContent).toBe('Getting started')
    expect(texts('project-home-building-line', panel)).toEqual(NEW_LAUNCH.lines)
    expect(tid('project-home-building-elapsed', panel)?.textContent).toBe(elapsed)
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('project-home-job-status')).toBeNull()
    const open = tid('project-home-open-session') as HTMLButtonElement
    expect(open.textContent).toBe('Open session')
    click(open)
    expect(onOpenSession.mock.calls).toEqual([['epic-1']])
  })

  it('regenerating in place turns that entry\'s row into the building row instead of adding one', () => {
    mount({ jobStatus: status({ state: 'running', status: 'running', startedAt: isoAgo(120_000) }), lastLaunch: REGEN_LAUNCH })
    expect(ids()).toEqual(['overview', 'how-it-works', 'faq', 'billing-flow'])
    expect(current()).toEqual([null, 'true', null, null])
    expect(tid('project-home-pages-count')?.textContent).toBe('4')
    expect(texts('project-home-building-row')).toHaveLength(1)
    const row = tid('project-home-building-row', rows()[1])!
    expect(col(row, 'title')).toBe('How it works')
    expect(col(row, 'meta')).toBe('Building… started 2m ago')
    expect(tid('entry-rename')).toBeNull()
    expect(tid('project-home-page-title')?.textContent).toBe('How it works')
    expect(tid('project-home-page-sub')?.textContent).toBe('How it works · contributors · in-depth')
    expect(texts('project-home-building-line', tid('project-home-building')!)).toEqual(REGEN_LAUNCH.lines)
  })

  it('another row opens while building (Regenerate… disabled, its actions back); the building row brings the panel back', async () => {
    mount({ jobStatus: status({ state: 'queued' }), lastLaunch: NEW_LAUNCH })
    click(rows()[2])
    await flush()
    expect(tid('project-home-building')).toBeNull()
    expect(tid('project-home-page-title')?.textContent).toBe('How it works')
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('entry-rename', items()[2])).not.toBeNull()
    click(rows()[0])
    expect(tid('project-home-building')).not.toBeNull()
    expect(tid('entry-rename')).toBeNull()
  })

  it('after an app reload (no launch from this window) the building row uses the macro label and the panel has no lines box', () => {
    mount({ jobStatus: status({ state: 'queued' }) })
    expect(col(tid('project-home-building-row', rows()[0])!, 'title')).toBe('Project Home')
    expect(tid('project-home-page-title')?.textContent).toBe('Project Home')
    expect(tid('project-home-page-sub')?.textContent).toBe('')
    expect(tid('project-home-building-title')?.textContent).toBe('Project Home')
    expect(tid('project-home-building-lines')).toBeNull()
  })

  it('a first build with no pages yet shows the library with only the building row', () => {
    mount({ entries: [], jobStatus: status({ state: 'queued' }), lastLaunch: NEW_LAUNCH })
    expect(tid('knowledge-page-empty')).toBeNull()
    expect(ids()).toEqual([BUILDING_ROW_ID])
    expect(tid('project-home-pages-count')?.textContent).toBe('1')
    expect(tid('project-home-building')?.getAttribute('data-state')).toBe('queued')
  })

  it('a Regenerate… whose entry is gone builds as a new row', () => {
    mount({ entries: [OVERVIEW], jobStatus: status({ state: 'queued' }), lastLaunch: REGEN_LAUNCH })
    expect(ids()).toEqual([BUILDING_ROW_ID, 'overview'])
    expect(col(rows()[0], 'title')).toBe('How it works')
  })

  it('launching selects the row the build shows in', () => {
    mount()
    click(rows()[2])
    click(tid('project-home-generate'))
    click(tid('composer-generate'))
    rerender({ jobStatus: status({ state: 'queued' }), lastLaunch: NEW_LAUNCH })
    expect(current()).toEqual(['true', null, null, null, null])
    expect(tid('project-home-building')).not.toBeNull()
  })

  it('failed: the job reason with Open session sits in the building row\'s place and Generate is enabled again', () => {
    const onOpenSession = vi.fn()
    mount({
      jobStatus: status({ state: 'failed', status: 'failed', reason: 'Timed out at the 30-minute job budget', finishedAt: isoAgo(60_000) }),
      lastLaunch: { ...NEW_LAUNCH, at: Date.now() - 120_000 },
      onOpenSession,
    })
    const failed = tid('project-home-build-failed')!
    expect(failed.compareDocumentPosition(rows()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const line = tid('project-home-job-status', failed)!
    expect(line.textContent).toBe('Failed: Timed out at the 30-minute job budget')
    expect(line.getAttribute('role')).toBe('alert')
    click(tid('project-home-job-session', failed))
    expect(onOpenSession.mock.calls).toEqual([['epic-1']])
    expect(ids()).toEqual(['overview', 'how-it-works', 'faq', 'billing-flow'])
    expect(tid('project-home-building')).toBeNull()
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(false)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(false)
  })

  it('the next launch clears the failure; its job then shows as building', () => {
    const failedJob = status({ state: 'failed', status: 'failed', reason: 'boom', finishedAt: isoAgo(60_000) })
    mount({ jobStatus: failedJob })
    expect(tid('project-home-build-failed')).not.toBeNull()
    const relaunch = { ...NEW_LAUNCH, at: Date.now() }
    rerender({ jobStatus: failedJob, lastLaunch: relaunch })
    expect(tid('project-home-build-failed')).toBeNull()
    rerender({ jobStatus: status({ state: 'queued', slug: 's2' }), lastLaunch: relaunch })
    expect(tid('project-home-build-failed')).toBeNull()
    expect(col(tid('project-home-building-row')!, 'meta')).toBe('Queued')
  })

  it('a failure with no pages yet shows in the empty state, its starter cards still enabled', () => {
    mount({ entries: [], jobStatus: status({ state: 'failed', status: 'failed', reason: 'boom', epicId: null }) })
    const line = tid('project-home-job-status', tid('knowledge-page-empty')!)!
    expect(line.textContent).toBe('Failed: boom')
    expect(tid('project-home-job-session')).toBeNull()
    expect((tid('template-card-quick') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('ProjectHome page builds', () => {
  const PAGES = { knowledge: ENTRIES, videos: [], html: null, mtimeMs: null, demoVideo: null }
  const changed = new Set<(payload: unknown) => void>()
  let jobRows: MacroJobStatus[] = []

  beforeEach(() => {
    jobRows = []
    changed.clear()
    launchSpy.mockReset()
    __resetMacrosCacheForTests()
    useSessions.setState({ tabs: [{ id: 't1', cwd: '/proj' } as never], activeTabId: 't1' })
    ;(window as unknown as { api: unknown }).api = {
      config: { readText },
      schedule: { listPrds: vi.fn(async () => []), onState: vi.fn(() => () => {}) },
      macros: { list: vi.fn(async () => [HOME]), onChanged: vi.fn(() => () => {}), jobStatus: vi.fn(async () => jobRows) },
      projectPages: {
        get: vi.fn(async () => PAGES),
        watch: vi.fn(async () => undefined),
        unwatch: vi.fn(async () => undefined),
        onChanged: vi.fn((cb: (payload: unknown) => void) => {
          changed.add(cb)
          return () => changed.delete(cb)
        }),
        rename,
        delete: del,
      },
      agents: { listPersonas: vi.fn(async () => []) },
    }
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  async function mountHome() {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(<ProjectHome />)
      await settle()
    })
  }
  /** A project-pages change for the cwd: useMacroJobStatus re-reads the job rows at once (no throttle). */
  async function push(next: MacroJobStatus[]) {
    jobRows = next
    await act(async () => {
      for (const cb of changed) cb({ cwd: '/proj', ...PAGES })
      await settle()
    })
  }
  const ready = (title: string) => useToast.getState().toasts.filter((t) => t.message === `“${title}” is ready`)

  it('shows this window\'s launch as the building row, then toasts “<title>” is ready exactly once when the job is done', async () => {
    await mountHome()
    click(tid('project-home-generate'))
    click(tid('composer-generate'))
    expect(launchSpy.mock.calls).toEqual([[HOME, OVERVIEW_LINES]])
    const job = status({ slug: 'project-home-build-1', status: 'pending' })
    await push([job])
    expect(ids()[0]).toBe(BUILDING_ROW_ID)
    expect(col(rows()[0], 'title')).toBe('Overview')
    expect(texts('project-home-building-line')).toEqual(OVERVIEW_LINES.split('\n'))
    await push([{ ...job, state: 'running', status: 'running', startedAt: isoAgo(2_000) }])
    expect(tid('project-home-building')?.getAttribute('data-state')).toBe('running')
    expect(ready('Overview')).toHaveLength(0)
    const done = { ...job, state: 'done' as const, status: 'completed', finishedAt: new Date().toISOString() }
    await push([done])
    await push([{ ...done }])
    expect(ready('Overview')).toHaveLength(1)
    expect(tid('project-home-building-row')).toBeNull()
    expect(tid('project-home-building')).toBeNull()
  })

  it('after a reload the building row and the ready toast fall back to the macro label', async () => {
    jobRows = [status({ slug: 'project-home-build-2', state: 'running', status: 'running', startedAt: isoAgo(60_000) })]
    await mountHome()
    expect(col(rows()[0], 'title')).toBe('Project Home')
    expect(tid('project-home-building-lines')).toBeNull()
    await push([{ ...jobRows[0], state: 'done', status: 'completed', finishedAt: new Date().toISOString() }])
    expect(ready('Project Home')).toHaveLength(1)
  })

  it('a job already done when the page opens never toasts', async () => {
    jobRows = [status({ slug: 'project-home-build-3', state: 'done', status: 'completed', finishedAt: isoAgo(60_000) })]
    await mountHome()
    await push([...jobRows])
    expect(tid('project-home-library')).not.toBeNull()
    expect(useToast.getState().toasts).toEqual([])
  })
})

describe('fitInstructions', () => {
  it('joins fixed lines, Focus and the tail with newlines when they fit', () => {
    expect(fitInstructions(['a', 'b'], '', [])).toBe('a\nb')
    expect(fitInstructions(['a'], 'focus', ['Replace entry: x'])).toBe('a\nfocus\nReplace entry: x')
  })

  it('cuts Focus first and never the tail', () => {
    expect(fitInstructions(['abc'], 'focus text', ['tail'], 15)).toBe('abc\nfocus\ntail')
    expect(fitInstructions(['abc'], 'focus', ['tail'], 9)).toBe('abc\ntail')
  })

  it('drops Focus and cuts the longest fixed line when the other lines alone overflow', () => {
    const topic = `Page: Custom topic: ${'y'.repeat(50)}`
    const out = fitInstructions([topic, 'Audience: Users'], 'focus', ['Replace entry: t'], 60)
    expect(out).toBe(`${topic.slice(0, 27)}\nAudience: Users\nReplace entry: t`)
    expect(out.length).toBe(60)
  })

  it('never splits a surrogate pair', () => {
    expect(fitInstructions(['a'], '😀😀', [], 5)).toBe('a\n😀')
  })
})
