// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EXTRA_INSTRUCTIONS_CAP, PagesPane, fitInstructions, type PagesPaneProps } from '../PagesPane'
import { useToast } from '../../../../../state/toast'
import type { ProjectKnowledgeEntry } from '../../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus } from '../../../../../../preload/api'

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

  it('with no entries keeps the knowledge-page-empty element with a Generate page button that launches', () => {
    const onLaunch = vi.fn()
    const el = mount({ entries: [], onLaunch })
    const empty = tid('knowledge-page-empty', el)!
    expect(empty.textContent).toContain('No knowledge pages yet.')
    expect(tid('project-home-library')).toBeNull()
    expect(tid('project-home-regenerate')).toBeNull()
    click(tid('project-home-generate', empty))
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[HOME, OVERVIEW_LINES]])
  })

  it('an open composer keeps its form when the first page lands under it', async () => {
    const onLaunch = vi.fn()
    mount({ entries: [], onLaunch })
    click(tid('project-home-generate'))
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

  it.each(['queued', 'running'] as const)('disables both buttons while the page job is %s, with the status line under Generate', (state) => {
    const onOpenSession = vi.fn()
    mount({ jobStatus: status({ state, status: state }), onOpenSession })
    const gen = tid('project-home-generate') as HTMLButtonElement
    expect(gen.disabled).toBe(true)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
    const line = tid('project-home-job-status')!
    expect(line.textContent).toBe(state === 'queued' ? 'Queued' : 'Building… started just now')
    expect(gen.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    click(tid('project-home-job-session'))
    expect(onOpenSession).toHaveBeenCalledWith('epic-1')
  })

  it('re-enables once the job is done and keeps its status line', () => {
    mount({ jobStatus: status({ state: 'done', status: 'completed', finishedAt: new Date(Date.now() - 60_000).toISOString() }) })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(false)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(false)
    expect(tid('project-home-job-status')?.textContent).toBe('Done 1m ago')
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
