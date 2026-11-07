// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  ProjectHomeKeyButtons,
  libraryKeyMeta,
  libraryKeyStats,
  type KeyLibraryStats,
  type ProjectHomeTab,
} from '../ProjectHomeKeyButtons'
import { ProjectHome } from '../../ProjectHome'
import { useSessions } from '../../../../../state/sessions'
import { __resetMacrosCacheForTests } from '../../../../../lib/useMacros'
import type { Macro, MacroJobStatus } from '../../../../../../preload/api'

const HOUR = 3_600_000
const NONE: KeyLibraryStats = { count: 0, building: 0, latestMs: null }

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const key = (el: HTMLElement, tab: ProjectHomeTab) =>
  el.querySelector(`[data-testid="project-home-key"][data-tab="${tab}"]`) as HTMLButtonElement
const meta = (btn: HTMLElement) => btn.querySelector('[data-testid="project-home-key-meta"]')?.textContent
const badge = (btn: HTMLElement) => btn.querySelector('[data-testid="project-home-key-count"]') as HTMLElement | null
const iconBox = (btn: HTMLElement) => btn.querySelector('[data-testid="project-home-key-icon"]') as HTMLElement

function status(state: MacroJobStatus['state'], macroId = 'builtin-project-home'): MacroJobStatus {
  return { macroId, epicId: 'e1', slug: 's', state, status: state, reason: null, startedAt: null, finishedAt: null }
}

describe('libraryKeyMeta', () => {
  const now = Date.parse('2026-11-07T12:00:00Z')

  it('says Nothing generated yet when nothing exists or builds', () => {
    expect(libraryKeyMeta(NONE, 'page', now)).toBe('Nothing generated yet')
    expect(libraryKeyMeta(NONE, 'video', now)).toBe('Nothing generated yet')
  })

  it('says <n> building · <m> ready while a build runs', () => {
    expect(libraryKeyMeta({ count: 2, building: 1, latestMs: now - HOUR }, 'video', now)).toBe('1 building · 2 ready')
    expect(libraryKeyMeta({ count: 0, building: 1, latestMs: null }, 'page', now)).toBe('1 building · 0 ready')
  })

  it('says <n> pages|videos · latest <ago> otherwise, singular for one', () => {
    expect(libraryKeyMeta({ count: 3, building: 0, latestMs: now - 26 * HOUR }, 'page', now)).toBe('3 pages · latest 1d ago')
    expect(libraryKeyMeta({ count: 1, building: 0, latestMs: now - 2 * HOUR }, 'video', now)).toBe('1 video · latest 2h ago')
    expect(libraryKeyMeta({ count: 2, building: 0, latestMs: null }, 'page', now)).toBe('2 pages')
  })
})

describe('libraryKeyStats', () => {
  const entry = (mtimeMs: number, createdAt: string | null) => ({ mtimeMs, meta: createdAt === null ? null : { createdAt } })

  it('counts entries and takes the newest createdAt, falling back to mtimeMs', () => {
    const stats = libraryKeyStats(
      [entry(5_000, '1970-01-01T00:00:02.000Z'), entry(9_000, null), entry(1_000, 'not a date')],
      undefined,
    )
    expect(stats).toEqual({ count: 3, building: 0, latestMs: 9_000 })
    expect(libraryKeyStats([entry(1_000, '1970-01-01T00:00:20.000Z')], undefined).latestMs).toBe(20_000)
    expect(libraryKeyStats([], undefined)).toEqual(NONE)
  })

  it('counts a queued or running job as one building; done and failed count none', () => {
    expect(libraryKeyStats([], status('queued')).building).toBe(1)
    expect(libraryKeyStats([], status('running')).building).toBe(1)
    expect(libraryKeyStats([], status('done')).building).toBe(0)
    expect(libraryKeyStats([], status('failed')).building).toBe(0)
  })
})

describe('ProjectHomeKeyButtons', () => {
  const now = Date.now()
  const PAGES: KeyLibraryStats = { count: 3, building: 0, latestMs: now - 26 * HOUR }
  const VIDEOS: KeyLibraryStats = { count: 2, building: 1, latestMs: now - HOUR }

  function render(over: Partial<React.ComponentProps<typeof ProjectHomeKeyButtons>> = {}) {
    return mount(
      <ProjectHomeKeyButtons tab="pages" onTabChange={() => {}} pages={PAGES} videos={VIDEOS} findingsCount={null} {...over} />,
    )
  }

  it('renders Pages, Videos, Tools in order with aria-pressed on the active one only', () => {
    const el = render({ tab: 'videos' })
    const btns = Array.from(el.querySelectorAll('[data-testid="project-home-key"]'))
    expect(btns.map((b) => b.getAttribute('data-tab'))).toEqual(['pages', 'videos', 'tools'])
    expect(btns.map((b) => b.querySelector('[data-testid="project-home-key-label"]')?.textContent)).toEqual([
      'Pages',
      'Videos',
      'Tools',
    ])
    expect(btns.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
  })

  it('styles the selected key ink with an accent icon box; the others bg-hi with a structural border', () => {
    const el = render({ tab: 'pages' })
    const on = key(el, 'pages')
    const off = key(el, 'videos')
    expect(on.className).toContain('bg-fg')
    expect(on.className).toContain('text-bg')
    expect(iconBox(on).className).toContain('bg-accent')
    expect(off.className).toContain('bg-bg-hi')
    expect(off.className).toContain('border-rule-structural')
    expect(off.className).not.toContain('bg-fg')
    expect(iconBox(off).className).not.toContain('bg-accent')
  })

  it('shows each library meta line and a badge of ready + building entries', () => {
    const el = render()
    expect(meta(key(el, 'pages'))).toBe('3 pages · latest 1d ago')
    expect(badge(key(el, 'pages'))?.textContent).toBe('3')
    expect(meta(key(el, 'videos'))).toBe('1 building · 2 ready')
    expect(badge(key(el, 'videos'))?.textContent).toBe('3')
  })

  it('shows 0 and Nothing generated yet for an empty library', () => {
    const el = render({ pages: NONE })
    expect(meta(key(el, 'pages'))).toBe('Nothing generated yet')
    expect(badge(key(el, 'pages'))?.textContent).toBe('0')
  })

  it('hides the Tools badge while findingsCount is null and shows it (accent) once known', () => {
    const el = render()
    expect(badge(key(el, 'tools'))).toBeNull()
    expect(meta(key(el, 'tools'))).toBe('Review MD network')
    act(() =>
      root!.render(
        <ProjectHomeKeyButtons tab="pages" onTabChange={() => {}} pages={PAGES} videos={VIDEOS} findingsCount={3} />,
      ),
    )
    expect(badge(key(el, 'tools'))?.textContent).toBe('3')
    expect(badge(key(el, 'tools'))?.className).toContain('bg-accent')
    expect(meta(key(el, 'tools'))).toBe('Review MD network · 3 findings')
    act(() =>
      root!.render(
        <ProjectHomeKeyButtons tab="pages" onTabChange={() => {}} pages={PAGES} videos={VIDEOS} findingsCount={1} />,
      ),
    )
    expect(meta(key(el, 'tools'))).toBe('Review MD network · 1 finding')
  })

  it('clicking a key reports its tab', () => {
    const onTabChange = vi.fn()
    const el = render({ onTabChange })
    act(() => key(el, 'tools').click())
    act(() => key(el, 'videos').click())
    act(() => key(el, 'pages').click())
    expect(onTabChange.mock.calls.map((c) => c[0])).toEqual(['tools', 'videos', 'pages'])
  })
})

describe('ProjectHome wiring', () => {
  const macro = (id: string, label: string): Macro => ({
    id,
    label,
    agentName: 'architect',
    tag: 'discussion',
    prompt: 'Go.',
    projects: ['*'],
    surface: 'project-home',
    createdAt: '',
    updatedAt: '',
  })
  const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString()
  const page = (id: string, agoMs: number) => ({
    id,
    path: `/proj/k/${id}/index.html`,
    mtimeMs: Date.now() - agoMs,
    error: null,
    meta: { id, title: `Page ${id}`, topic: 't', createdAt: iso(agoMs), model: 'm' },
  })
  const video = (id: string, agoMs: number) => ({
    id,
    path: `/proj/v/${id}/index.html`,
    mtimeMs: Date.now() - agoMs,
    error: null,
    meta: { id, title: `Video ${id}`, kind: 'project-demo', style: 'Auto', lengthS: 30, createdAt: iso(agoMs), character: null, sources: [], report: { lufs: null, truePeakDb: null, speechS: null, readingGrade: null, checks: [], bytes: 1 } },
  })

  beforeEach(() => {
    __resetMacrosCacheForTests()
    useSessions.setState({ tabs: [{ id: 't1', cwd: '/proj' } as never], activeTabId: 't1' })
    ;(window as unknown as { api: unknown }).api = {
      schedule: { listPrds: vi.fn(async () => []), onState: vi.fn(() => () => {}) },
      macros: {
        list: vi.fn(async () => [
          macro('builtin-project-home', 'Project Home'),
          macro('builtin-demo-video', 'Demo Video'),
          macro('review-md', 'Review MD network'),
        ]),
        onChanged: vi.fn(() => () => {}),
        jobStatus: vi.fn(async () => [status('running', 'builtin-demo-video')]),
      },
      projectPages: {
        get: vi.fn(async () => ({
          knowledge: [page('b', 2 * HOUR), page('a', 50 * HOUR)],
          videos: [video('v1', 3 * HOUR)],
          html: null,
          mtimeMs: null,
          demoVideo: null,
        })),
        watch: vi.fn(async () => undefined),
        unwatch: vi.fn(async () => undefined),
        onChanged: vi.fn(() => () => {}),
      },
      agents: { listPersonas: vi.fn(async () => []) },
      config: { readText: vi.fn(async () => ({ exists: true, text: '<html><body>P</body></html>' })) },
    }
  })

  afterEach(() => {
    useSessions.setState({ tabs: [], activeTabId: null })
  })

  async function mountHome() {
    const el = mount(<ProjectHome />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    return el
  }

  it('opens on Pages, with the key buttons above the section', async () => {
    const el = await mountHome()
    expect(key(el, 'pages').getAttribute('aria-pressed')).toBe('true')
    expect(el.querySelectorAll('[data-testid="knowledge-page-item"]')).toHaveLength(2)
    const keys = el.querySelector('[data-testid="project-home-keys"]') as HTMLElement
    const section = el.querySelector('[data-testid="project-home-section"]') as HTMLElement
    expect(keys.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('computes the key counts from the library and the macro job status', async () => {
    const el = await mountHome()
    expect(meta(key(el, 'pages'))).toBe('2 pages · latest 2h ago')
    expect(badge(key(el, 'pages'))?.textContent).toBe('2')
    expect(meta(key(el, 'videos'))).toBe('1 building · 1 ready')
    expect(badge(key(el, 'videos'))?.textContent).toBe('2')
    expect(badge(key(el, 'tools'))).toBeNull()
  })

  it('switches the section with the keys: Tools shows the tools list, Videos the video list', async () => {
    const el = await mountHome()
    act(() => key(el, 'tools').click())
    expect(key(el, 'tools').getAttribute('aria-pressed')).toBe('true')
    expect(key(el, 'pages').getAttribute('aria-pressed')).toBe('false')
    expect(el.querySelector('[data-testid="knowledge-page-item"]')).toBeNull()
    const tools = Array.from(el.querySelectorAll('[data-testid="project-home-tool"]'))
    expect(tools.map((b) => b.getAttribute('data-macro-id'))).toEqual(['review-md'])
    act(() => key(el, 'videos').click())
    expect(el.querySelectorAll('[data-testid="video-item"]')).toHaveLength(1)
    expect(el.querySelector('[data-testid="project-home-tool"]')).toBeNull()
  })
})
