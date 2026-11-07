// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { VideosPane, type VideosPaneProps } from '../VideosPane'
import { EXTRA_INSTRUCTIONS_CAP } from '../PagesPane'
import { VIDEO_STYLES } from '../composerTemplates'
import { useToast } from '../../../../../state/toast'
import type { ProjectVideoEntry } from '../../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro, MacroJobStatus, ProjectVideoMeta } from '../../../../../../preload/api'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const rename = vi.fn()
const del = vi.fn()

beforeEach(() => {
  rename.mockReset().mockResolvedValue({ ok: true, title: 'x' })
  del.mockReset().mockResolvedValue({ ok: true })
  ;(window as unknown as { api: unknown }).api = { projectPages: { rename, delete: del } }
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

const DEMO: Macro = {
  id: 'builtin-demo-video',
  label: 'Demo Video',
  agentName: 'demo-video-builder',
  tag: 'project-home-builder',
  prompt: 'Build it.',
  projects: ['*'],
  surface: 'project-home',
  createdAt: '',
  updatedAt: '',
}

type MetaOver = Partial<Omit<ProjectVideoMeta, 'report'>> & { report?: Partial<ProjectVideoMeta['report']> }

function video(id: string, title: string, agoMs: number, over: MetaOver = {}): ProjectVideoEntry {
  const t = Date.now() - agoMs
  const { report, ...rest } = over
  return {
    id,
    path: `/proj/videos/${id}/index.html`,
    mtimeMs: t,
    error: null,
    meta: {
      id,
      title,
      kind: 'project-demo',
      style: 'Auto',
      lengthS: 30,
      createdAt: new Date(t).toISOString(),
      character: null,
      sources: [],
      macroVersion: 1,
      seedVersion: 1,
      model: 'sonnet',
      effort: 'medium',
      ...rest,
      report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: 1, ...report },
    },
  }
}

const TOUR = video('product-tour', 'Product tour', 2 * HOUR, {
  style: 'Kinetic typography',
  character: 'Burrow',
  sources: [
    { claim: 'Runs Claude Code sessions side by side', source: 'README.md', ref: 'Features' },
    { claim: 'Queues PRDs as headless jobs', source: 'src/main/scheduler.cjs', ref: 'dispatch' },
    { claim: 'Free and open-core', source: 'CLAUDE.md', ref: '' },
  ],
  report: {
    lufs: -16.2,
    truePeakDb: -1.4,
    speechS: 24,
    readingGrade: 6.1,
    checks: [
      { id: 'length', ok: true, detail: 'Length matches sm-demo-duration (30s)' },
      { id: 'network', ok: false, detail: 'Calls fetch() at 0:12' },
    ],
  },
})
const NOTES = video('release-notes', 'Release notes', DAY + HOUR, { kind: 'blog-post', style: 'Professional', lengthS: 60 })
const BROKEN: ProjectVideoEntry = {
  id: 'broken',
  path: '/proj/videos/broken/index.html',
  mtimeMs: Date.now() - 3 * DAY - HOUR,
  error: 'meta.json missing',
  meta: null,
}
const ENTRIES = [TOUR, NOTES, BROKEN]

/** The Project demo template's default prompt lines (it uses the mascot, so Character is on), joined. */
const DEMO_LINES = 'Video kind: Project demo\nVideo style: Auto\nVideo length: 30\nCharacter: on'
/** Product tour's Regenerate pre-fill (`videoCfgFromEntry`), joined. */
const TOUR_LINES = 'Video kind: Project demo\nVideo style: Kinetic typography\nVideo length: 30\nCharacter: on'

function props(over: Partial<VideosPaneProps> = {}): VideosPaneProps {
  return { cwd: '/proj', entries: ENTRIES, macro: DEMO, launching: null, onLaunch: vi.fn(), ...over }
}

function mount(over: Partial<VideosPaneProps> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<VideosPane {...props(over)} />))
  return container
}
const rerender = (over: Partial<VideosPaneProps>) => act(() => root!.render(<VideosPane {...props(over)} />))
const flush = () => act(async () => { await Promise.resolve() })

/** The composer portals into document.body, so every lookup searches the whole document. */
const tid = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const tids = (id: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))
const rows = () => tids('video-item')
/** The list's own `<li>`s — the report's checks are a list too. */
const items = () => Array.from(container!.querySelectorAll<HTMLElement>('ul[aria-label="Videos"] > li'))
const col = (scope: ParentNode, name: string) => scope.querySelector(`[data-col="${name}"]`)?.textContent
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
  macroId: 'builtin-demo-video',
  epicId: 'epic-1',
  slug: 's',
  state: 'queued',
  status: 'queued',
  reason: null,
  startedAt: null,
  finishedAt: null,
  ...over,
})
const styleClass = (id: string) => VIDEO_STYLES.find((s) => s.id === id)!.className
/** QUALITY REPORT stats as [value, label] pairs. */
const stats = () =>
  Array.from(tid('video-report')!.querySelectorAll('[data-stat]')).map((s) => [col(s, 'value'), col(s, 'label')])
const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('VideosPane list column', () => {
  it('lists every video under VIDEOS and the count: title, "<kind> · <len>s · <ago>" and "LUFS <x> · grade <y>"', () => {
    mount()
    expect(tid('project-home-videos-header')?.textContent).toContain('VIDEOS')
    expect(tid('project-home-videos-count')?.textContent).toBe('3')
    expect(rows().map((r) => r.getAttribute('data-id'))).toEqual(['product-tour', 'release-notes', 'broken'])
    const [tour, notes] = rows()
    expect(col(tour, 'title')).toBe('Product tour')
    expect(col(tour, 'meta')).toBe('project-demo · 30s · 2h ago')
    expect([col(tour, 'kind'), col(tour, 'length'), col(tour, 'created')]).toEqual(['project-demo', '30s', '2h ago'])
    expect(col(tour, 'report')).toBe('LUFS -16.2 · grade 6.1')
    expect([col(tour, 'lufs'), col(tour, 'grade')]).toEqual(['-16.2', '6.1'])
    expect(col(notes, 'meta')).toBe('blog-post · 60s · 1d ago')
    expect([col(notes, 'lufs'), col(notes, 'grade')]).toEqual(['-', '-'])
  })

  it('gives each row an 86px 16:9 thumbnail in the style colours with the title and an m:ss duration badge', () => {
    mount()
    const [tour, notes, broken] = rows()
    const thumb = tid('video-thumb', tour)!
    expect(thumb.className).toContain('w-[86px]')
    expect(thumb.className).toContain('aspect-video')
    expect(thumb.className).toContain(styleClass('Kinetic typography'))
    expect(thumb.getAttribute('data-style')).toBe('Kinetic typography')
    expect(thumb.getAttribute('aria-hidden')).toBe('true')
    expect(col(thumb, 'thumb-title')).toBe('Product tour')
    expect(tid('video-duration', tour)?.textContent).toBe('0:30')
    expect(tid('video-thumb', notes)!.className).toContain(styleClass('Professional'))
    expect(tid('video-duration', notes)?.textContent).toBe('1:00')
    // Unreadable meta: Auto colours, the id as its text, no duration to show.
    expect(tid('video-thumb', broken)?.getAttribute('data-style')).toBe('Auto')
    expect(col(tid('video-thumb', broken)!, 'thumb-title')).toBe('broken')
    expect(tid('video-duration', broken)).toBeNull()
  })

  it('matches a recorded style case-insensitively and falls back to Auto for an unknown one', () => {
    mount({ entries: [video('a', 'A', HOUR, { style: 'fun' }), video('b', 'B', HOUR, { style: 'Claymation' })] })
    expect(rows().map((r) => tid('video-thumb', r)?.getAttribute('data-style'))).toEqual(['Fun', 'Auto'])
    expect(tid('video-thumb', rows()[1])!.className).toContain(styleClass('Auto'))
  })

  it('puts a full-width accent Generate video button above the list', () => {
    mount()
    const btn = tid('project-home-generate') as HTMLButtonElement
    expect(btn.getAttribute('data-kind')).toBe('video')
    expect(btn.textContent).toBe('Generate video')
    expect(btn.className).toContain('w-full')
    expect(btn.className).toContain('bg-accent')
    expect(btn.disabled).toBe(false)
    expect(follows(btn, tid('project-home-videos-header')!)).toBe(true)
    expect(follows(tid('project-home-videos-header')!, rows()[0])).toBe(true)
  })

  it('shows an unreadable entry as its id and error, in its row and in the content column', () => {
    mount({ entries: [BROKEN] })
    expect(col(rows()[0], 'title')).toBe('broken: meta.json missing')
    expect(col(rows()[0], 'meta')).toBe('3d ago')
    expect(col(rows()[0], 'report')).toBeUndefined()
    expect(tid('project-home-video-title')?.textContent).toBe('broken')
    expect(tid('project-home-video-sub')?.textContent).toBe('3d ago')
    expect(tid('project-home-video-error')?.textContent).toBe('meta.json missing')
    expect(tid('video-player-frame')).toBeNull()
    expect(tid('video-sources')).toBeNull()
    expect(tid('video-report')).toBeNull()
  })

  it('with no entries keeps the video-page-empty element with a Generate video button that launches', () => {
    const onLaunch = vi.fn()
    const el = mount({ entries: [], onLaunch })
    const empty = tid('video-page-empty', el)!
    expect(empty.textContent).toContain('No videos yet.')
    expect(tid('project-home-library')).toBeNull()
    expect(tid('project-home-regenerate')).toBeNull()
    click(tid('project-home-generate', empty))
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[DEMO, DEMO_LINES]])
  })

  it('lays the list beside the content as the 252px | 1fr grid Pages uses', () => {
    mount()
    const grid = tid('project-home-library')!
    expect(grid.style.gridTemplateColumns.replace(/\s/g, '')).toBe('252pxminmax(0,1fr)')
    expect(grid.className).toContain('gap-[20px]')
  })
})

describe('VideosPane content column', () => {
  it('selects the first video by default: serif title bar, mono sub, Regenerate… and the VideoPlayer', () => {
    mount()
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual(['true', null, null])
    const title = tid('project-home-video-title')!
    expect(title.textContent).toBe('Product tour')
    expect(title.className).toContain('font-serif')
    const sub = tid('project-home-video-sub')!
    expect(sub.textContent).toBe('project-demo · 30s · kinetic typography · 2h ago')
    expect(sub.className).toContain('font-mono')
    expect(tid('project-home-regenerate')?.textContent).toBe('Regenerate…')
    const frame = tid('video-player-frame', tid('project-home-content')!)!
    expect(frame.getAttribute('src')).toBe('smfile://local/proj/videos/product-tour/index.html')
  })

  it('scrolls on its own and stacks title bar, player, then SOURCES and QUALITY REPORT side by side', () => {
    mount()
    const content = tid('project-home-content')!
    expect(content.className).toContain('overflow-y-auto')
    expect(content.className).toContain('min-h-0')
    const order = ['project-home-video-title', 'video-player-frame', 'video-sources', 'video-report'].map((id) => tid(id, content)!)
    for (let i = 1; i < order.length; i++) expect(follows(order[i - 1], order[i])).toBe(true)
    expect(tid('video-cards', content)!.style.gridTemplateColumns.replace(/\s/g, '')).toBe('repeat(auto-fit,minmax(260px,1fr))')
  })

  it('SOURCES shows the claim count and each claim with "source › ref"', () => {
    mount()
    const card = tid('video-sources')!
    expect(card.textContent).toContain('SOURCES')
    expect(tid('video-sources-count', card)?.textContent).toBe('3 claims')
    expect(tids('video-source', card).map((s) => [col(s, 'claim'), col(s, 'ref')])).toEqual([
      ['Runs Claude Code sessions side by side', 'README.md › Features'],
      ['Queues PRDs as headless jobs', 'src/main/scheduler.cjs › dispatch'],
      ['Free and open-core', 'CLAUDE.md'],
    ])
  })

  it('QUALITY REPORT shows the four stats, then every check: a sage check when ok, an accent cross when not', () => {
    mount()
    const card = tid('video-report')!
    expect(card.textContent).toContain('QUALITY REPORT')
    expect(stats()).toEqual([
      ['-16.2', 'LUFS'],
      ['-1.4', 'true peak dB'],
      ['24s', 'speech'],
      ['6.1', 'reading grade'],
    ])
    const checks = tids('video-check', card)
    expect(checks.map((c) => [c.getAttribute('data-ok'), c.textContent])).toEqual([
      ['true', 'Length matches sm-demo-duration (30s)'],
      ['false', 'Calls fetch() at 0:12'],
    ])
    const [ok, bad] = checks.map((c) => tid('video-check-icon', c)!)
    expect(ok.className).toContain('text-sage-dark')
    expect(ok.getAttribute('aria-label')).toBe('Passed')
    expect(ok.querySelector('path')?.getAttribute('d')).toBe('M5 12l5 5 9-10')
    expect(bad.className).toContain('text-accent')
    expect(bad.getAttribute('aria-label')).toBe('Failed')
    expect(bad.querySelector('path')?.getAttribute('d')).toBe('M6 6l12 12M18 6L6 18')
  })

  it('shows "-" for every null report number, no checks, and 0 claims without sources', () => {
    mount({ entries: [NOTES] })
    expect(stats()).toEqual([
      ['-', 'LUFS'],
      ['-', 'true peak dB'],
      ['-', 'speech'],
      ['-', 'reading grade'],
    ])
    expect(tids('video-check')).toHaveLength(0)
    expect(tid('video-sources-count')?.textContent).toBe('0 claims')
    expect(tids('video-source')).toHaveLength(0)
  })

  it('says "1 claim" for a single source', () => {
    mount({ entries: [video('one', 'One', HOUR, { sources: [{ claim: 'c', source: 's', ref: 'r' }] })] })
    expect(tid('video-sources-count')?.textContent).toBe('1 claim')
  })

  it('a click selects another row and swaps the title bar, the player and the cards', () => {
    mount()
    click(rows()[1])
    expect(rows().map((r) => r.getAttribute('aria-current'))).toEqual([null, 'true', null])
    expect(tid('project-home-video-title')?.textContent).toBe('Release notes')
    expect(tid('project-home-video-sub')?.textContent).toBe('blog-post · 60s · professional · 1d ago')
    expect(tid('video-player-frame')?.getAttribute('src')).toBe('smfile://local/proj/videos/release-notes/index.html')
    expect(tid('video-sources-count')?.textContent).toBe('0 claims')
    click(rows()[2])
    expect(tid('project-home-video-error')?.textContent).toBe('meta.json missing')
    expect(tid('video-player-frame')).toBeNull()
  })

  it('keeps the pick across list refreshes and falls back to the first entry once it is gone', () => {
    mount()
    click(rows()[1])
    rerender({ entries: [video('newest', 'Newest', HOUR), ...ENTRIES] })
    expect(tid('project-home-video-title')?.textContent).toBe('Release notes')
    rerender({ entries: [BROKEN, TOUR] })
    expect(tid('project-home-video-title')?.textContent).toBe('broken')
  })

  it('follows a controlled selectedId and reports picks through onSelect', () => {
    const onSelect = vi.fn()
    mount({ selectedId: 'release-notes', onSelect })
    expect(rows()[1].getAttribute('aria-current')).toBe('true')
    click(rows()[0])
    expect(onSelect).toHaveBeenCalledWith('product-tour')
    expect(rows()[1].getAttribute('aria-current')).toBe('true')
  })
})

describe('VideosPane Generate and Regenerate', () => {
  it('Generate video opens the video composer and launches builtin-demo-video with its lines joined', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    expect(tid('project-home-composer')).toBeNull()
    click(tid('project-home-generate'))
    expect(tid('composer-title')?.textContent).toBe('Generate video')
    expect(tids('composer-template').map((t) => t.getAttribute('data-tpl'))).toEqual(['demo', 'feature', 'blog', 'whiteboard', 'custom'])
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[DEMO, DEMO_LINES]])
    expect(tid('project-home-composer')).toBeNull()
  })

  it('sends the picked template and the Focus text as lines joined with a newline', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(tid('project-home-generate'))
    click(document.querySelector<HTMLElement>('[data-testid="composer-template"][data-tpl="feature"]'))
    type(tid('composer-focus'), 'No jargon')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([
      [DEMO, 'Video kind: Feature\nVideo target: Scheduler / PRD queue\nVideo style: Kinetic typography\nVideo length: 30\nCharacter: off\nNo jargon'],
    ])
  })

  it('Regenerate… opens regen mode pre-filled from the video meta and appends Replace entry as the last line', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(tid('project-home-regenerate'))
    expect(tid('composer-title')?.textContent).toBe('Regenerate “Product tour”')
    expect(tid('composer-eyebrow')?.textContent).toBe('REBUILDING · product-tour')
    expect(tid('composer-template')).toBeNull()
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[DEMO, `${TOUR_LINES}\nReplace entry: product-tour`]])
    expect(tid('project-home-composer')).toBeNull()
  })

  it('Regenerate… of a blog post keeps its kind, style and 60s length, Character off without a mascot', () => {
    const onLaunch = vi.fn()
    mount({ onLaunch })
    click(rows()[1])
    click(tid('project-home-regenerate'))
    expect(tid('composer-title')?.textContent).toBe('Regenerate “Release notes”')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([
      [DEMO, 'Video kind: Blog post\nVideo style: Professional\nVideo length: 60\nCharacter: off\nReplace entry: release-notes'],
    ])
  })

  it('Regenerate… of an unreadable entry rebuilds it in place from the Project demo defaults', () => {
    const onLaunch = vi.fn()
    mount({ entries: [BROKEN], onLaunch })
    click(tid('project-home-regenerate'))
    expect(tid('composer-title')?.textContent).toBe('Regenerate “broken”')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[DEMO, `${DEMO_LINES}\nReplace entry: broken`]])
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
    const tail = '\nReplace entry: product-tour'
    const room = EXTRA_INSTRUCTIONS_CAP - TOUR_LINES.length - tail.length - 1
    expect(onLaunch.mock.calls).toEqual([[DEMO, `${TOUR_LINES}\n${'x'.repeat(room)}${tail}`]])
    expect((onLaunch.mock.calls[0][1] as string).length).toBe(EXTRA_INSTRUCTIONS_CAP)
  })

  it.each(['queued', 'running'] as const)('disables both buttons while the video job is %s, with the status line under Generate', (state) => {
    const onOpenSession = vi.fn()
    mount({ jobStatus: status({ state, status: state }), onOpenSession })
    const gen = tid('project-home-generate') as HTMLButtonElement
    expect(gen.disabled).toBe(true)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
    const line = tid('project-home-job-status')!
    expect(line.textContent).toBe(state === 'queued' ? 'Queued' : 'Building… started just now')
    expect(follows(gen, line)).toBe(true)
    expect(follows(line, tid('project-home-videos-header')!)).toBe(true)
    click(tid('project-home-job-session'))
    expect(onOpenSession).toHaveBeenCalledWith('epic-1')
  })

  it('re-enables once the job is done and keeps its status line', () => {
    mount({ jobStatus: status({ state: 'done', status: 'completed', finishedAt: new Date(Date.now() - 60_000).toISOString() }) })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(false)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(false)
    expect(tid('project-home-job-status')?.textContent).toBe('Done 1m ago')
  })

  it('shows a failed job with its reason in the empty state too', () => {
    mount({ entries: [], jobStatus: status({ state: 'failed', status: 'failed', reason: 'timed out after 30m' }) })
    const line = tid('project-home-job-status', tid('video-page-empty')!)!
    expect(line.textContent).toBe('Failed: timed out after 30m')
    expect(line.getAttribute('role')).toBe('alert')
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables both buttons while any macro launches, labelling its own launch Starting…', () => {
    mount({ launching: 'builtin-demo-video' })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('project-home-generate')?.textContent).toBe('Starting…')
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
    rerender({ launching: 'some-tool' })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect(tid('project-home-generate')?.textContent).toBe('Generate video')
  })

  it('without the builtin-demo-video macro both buttons stay disabled', () => {
    mount({ macro: undefined })
    expect((tid('project-home-generate') as HTMLButtonElement).disabled).toBe(true)
    expect((tid('project-home-regenerate') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('VideosPane rename and delete', () => {
  it('shows Rename and Delete under the selected row only', () => {
    mount()
    expect(tids('entry-rename')).toHaveLength(1)
    expect(tid('entry-rename', items()[0])).not.toBeNull()
    click(rows()[1])
    expect(tid('entry-rename', items()[0])).toBeNull()
    expect(tid('entry-rename', items()[1])).not.toBeNull()
    expect(tid('entry-delete', items()[1])).not.toBeNull()
  })

  it('Rename saves the inline title through projectPages.rename with kind video', async () => {
    mount()
    click(tid('entry-rename', items()[0]))
    const input = tid('entry-rename-input', items()[0]) as HTMLInputElement
    expect(input.value).toBe('Product tour')
    type(input, '  Tour  ')
    await press(input, 'Enter')
    expect(rename).toHaveBeenCalledWith('/proj', 'video', 'product-tour', 'Tour')
  })

  it('Delete asks "Delete this video?" inline, then deletes through projectPages.delete', async () => {
    mount()
    click(tid('entry-delete', items()[0]))
    expect(items()[0].textContent).toContain('Delete this video?')
    await act(async () => {
      tid('entry-delete-confirm', items()[0])!.click()
      await Promise.resolve()
    })
    expect(del).toHaveBeenCalledWith('/proj', 'video', 'product-tour')
  })

  it('shows no actions without a cwd', () => {
    mount({ cwd: null })
    expect(tid('entry-rename')).toBeNull()
    expect(tid('entry-delete')).toBeNull()
  })
})
