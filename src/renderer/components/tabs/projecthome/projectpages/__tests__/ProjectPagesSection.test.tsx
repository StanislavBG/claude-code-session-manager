// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectPagesSection } from '../ProjectPagesSection'
import { useToast } from '../../../../../state/toast'
import type { Macro, MacroJobStatus } from '../../../../../../preload/api'

const HTML = '<!DOCTYPE html><html><body>HOME</body></html>'

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = {
    config: { readText: vi.fn(async () => ({ exists: true, text: HTML, mtimeMs: 1, error: null, truncated: false })) },
  }
})

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

function macro(over: Partial<Macro> = {}): Macro {
  return {
    id: 'builtin-project-home',
    label: 'Project Home',
    agentName: 'project-home-builder',
    tag: 'project-home-builder',
    prompt: 'Generate it.',
    projects: ['*'],
    surface: 'project-home',
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

const HOME_MACRO = macro()
const DEMO_MACRO = macro({ id: 'builtin-demo-video', label: 'Demo Video', agentName: 'demo-video-builder' })
const MACROS = [HOME_MACRO, DEMO_MACRO]
const REVIEW = macro({ id: 'review-md', label: 'Review MD network' })

const kEntry = (id: string, title: string, mtimeMs: number, meta = true): any => ({
  id,
  path: `/tmp/k/${id}/index.html`,
  mtimeMs,
  error: meta ? null : 'meta.json missing',
  meta: meta ? { id, title, topic: 't', createdAt: new Date(mtimeMs).toISOString(), model: 'm' } : null,
})
const vEntry = (id: string, title: string, mtimeMs: number, over: any = {}, meta = true): any => ({
  id,
  path: `/tmp/v/${id}/index.html`,
  mtimeMs,
  error: meta ? null : 'bad meta',
  meta: meta
    ? {
        id, title, kind: 'project-demo', style: 'Fun', lengthS: 30,
        createdAt: new Date(mtimeMs).toISOString(), character: null, sources: [],
        report: { lufs: -16.2, truePeakDb: -1, speechS: 20, readingGrade: 7.5, checks: [], bytes: 1 },
        macroVersion: 1, seedVersion: 1, model: 'm', effort: 'x', ...over,
      }
    : null,
})
const NEW_K = kEntry('b', 'Newer page', 2000)
const OLD_K = kEntry('a', 'Older page', 1000)
const NEW_V = vEntry('v2', 'Newer video', 2000)
const OLD_V = vEntry('v1', 'Older video', 1000, { kind: 'blog-post', lengthS: 60, report: { lufs: null, readingGrade: null, checks: [], bytes: 1 } })

function props(over: Record<string, unknown> = {}) {
  return { tab: 'pages', knowledge: [], videos: [], loaded: true, macros: MACROS, launching: null, onLaunch: () => {}, ...over } as any
}
const flush = () => act(async () => { await Promise.resolve() })
/** Re-render the mounted section with new props (e.g. another `tab`), as ProjectHome does on a key press. */
const show = async (over: Record<string, unknown>) => {
  act(() => root!.render(<ProjectPagesSection {...props(over)} />))
  await flush()
}
const macroBtn = (el: HTMLElement, id: string) =>
  el.querySelector(`[data-testid="project-home-macro"][data-macro-id="${id}"]`) as HTMLButtonElement
/** PagesPane's controls; the Generate composer portals into document.body. */
const byTestId = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const generateBtn = () => byTestId('project-home-generate') as HTMLButtonElement | null
/** The building row's `Queued` / `Building… started <ago>` meta, when a build shows. */
const buildingMeta = (el: ParentNode) =>
  el.querySelector('[data-testid="project-home-building-row"] [data-col="meta"]')?.textContent ?? undefined
const typeInto = (el: HTMLElement | null, v: string) => {
  const field = el as HTMLInputElement | HTMLTextAreaElement
  const proto = field instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setValue.call(field, v)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** The Overview template's default composer lines, joined. */
const OVERVIEW_LINES = 'Page: Overview\nAudience: Newcomers\nLength: Standard\nRead from: README & docs, Source tree, Git log'
/** The Project demo video template's default composer lines, joined. */
const DEMO_LINES = 'Video kind: Project demo\nVideo style: Auto\nVideo length: 30\nCharacter: on'
/** Every control the old video / page toolbar MacroButton rendered. */
const OLD_TOOLBAR = [
  'project-home-macro',
  'project-home-macro-extra',
  'project-home-page-kind',
  'project-home-page-topic',
  'project-home-demo-kind',
  'project-home-demo-target',
  'project-home-demo-style',
  'project-home-demo-length',
]
const oldToolbar = (el: HTMLElement) => OLD_TOOLBAR.filter((id) => el.querySelector(`[data-testid="${id}"]`))

describe('ProjectPagesSection', () => {
  it('while loading shows a loading body, no page switch, empty state or page button', () => {
    const el = mount(<ProjectPagesSection {...props({ loaded: false })} />)
    expect(el.querySelector('[data-testid="project-home-page-switch"]')).toBeNull()
    expect(el.querySelector('[data-testid="project-home-loading"]')?.textContent).toBe('Loading pages…')
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).toBeNull()
    expect(el.querySelector('[data-testid="video-page-empty"]')).toBeNull()
    expect(macroBtn(el, 'builtin-project-home')).toBeNull()
    expect(generateBtn()).toBeNull()
  })

  it('loaded with no entries shows each empty state', async () => {
    const el = mount(<ProjectPagesSection {...props()} />)
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="project-home-loading"]')).toBeNull()
    await show({ tab: 'videos' })
    expect(el.querySelector('[data-testid="video-page-empty"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).toBeNull()
  })

  it('loaded with entries shows knowledge-page-item and video-item', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], videos: [NEW_V] })} />)
    await flush()
    expect(el.querySelector('[data-testid="knowledge-page-item"]')).not.toBeNull()
    await show({ knowledge: [NEW_K], videos: [NEW_V], tab: 'videos' })
    expect(el.querySelector('[data-testid="video-item"]')).not.toBeNull()
  })

  it('error shows the message and Retry calls onRetry, with no empty state', () => {
    const onRetry = vi.fn()
    const el = mount(<ProjectPagesSection {...props({ error: 'boom', onRetry })} />)
    expect(el.querySelector('[data-testid="project-home-load-error"]')?.textContent).toContain('boom')
    expect(el.querySelector('[data-testid="knowledge-page-empty"]')).toBeNull()
    expect(el.querySelector('[data-testid="video-page-empty"]')).toBeNull()
    act(() => (el.querySelector('[data-testid="project-home-retry"]') as HTMLElement).click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('the tab prop picks what renders; there is no page switch or legacy view toggle', async () => {
    const over = { knowledge: [NEW_K], videos: [NEW_V], macros: [...MACROS, REVIEW] }
    const el = mount(<ProjectPagesSection {...props(over)} />)
    await flush()
    expect(el.querySelector('[data-testid="project-home-page-switch"]')).toBeNull()
    expect(el.querySelector('[data-testid="project-home-view"]')).toBeNull()
    expect(el.querySelector('[data-page]')).toBeNull()
    const visible = () => ({
      knowledge: el.querySelectorAll('[data-testid="knowledge-page-item"]').length,
      videos: el.querySelectorAll('[data-testid="video-item"]').length,
      tools: el.querySelectorAll('[data-testid="project-home-tool"]').length,
    })
    expect(visible()).toEqual({ knowledge: 1, videos: 0, tools: 0 })
    await show({ ...over, tab: 'videos' })
    expect(visible()).toEqual({ knowledge: 0, videos: 1, tools: 0 })
    await show({ ...over, tab: 'tools' })
    expect(visible()).toEqual({ knowledge: 0, videos: 0, tools: 1 })
  })

  it('lays pages and videos out as a 252px list column beside a content pane that fills the height', async () => {
    for (const tab of ['pages', 'videos']) {
      const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], videos: [NEW_V], tab })} />)
      await flush()
      const grid = el.querySelector('[data-testid="project-home-library"]') as HTMLElement
      expect(grid.style.gridTemplateColumns.replace(/\s/g, '')).toBe('252pxminmax(0,1fr)')
      expect(grid.className).toContain('gap-[20px]')
      const pane = el.querySelector('[data-testid="project-home-content"]') as HTMLElement
      expect(pane.style.height).toBe('')
      expect(pane.getAttribute('style') ?? '').not.toContain('100vh')
      act(() => root?.unmount())
      container?.remove()
      root = null
    }
  })

  it('knowledge page lists entries in given (newest first) order and renders the selected in HtmlFrame', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K, OLD_K] })} />)
    await flush()
    const items = Array.from(el.querySelectorAll('[data-testid="knowledge-page-item"]'))
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('Newer page'), expect.stringContaining('Older page')])
    expect(el.querySelector('iframe[title="Newer page"]')?.getAttribute('srcdoc')).toBe(HTML)
    act(() => (items[1] as HTMLElement).click())
    await flush()
    expect(el.querySelector('iframe[title="Older page"]')).not.toBeNull()
    expect(items[1].getAttribute('aria-current')).toBe('true')
    expect(byTestId('project-home-page-title', el)?.textContent).toBe('Older page')
    // no toolbar MacroButton: PagesPane's Generate page + Regenerate… launch pages
    expect(macroBtn(el, 'builtin-project-home')).toBeNull()
    expect(macroBtn(el, 'builtin-demo-video')).toBeNull()
    expect(generateBtn()?.textContent).toBe('Generate page')
    expect(byTestId('project-home-regenerate', el)?.textContent).toBe('Regenerate…')
  })

  it('keeps the selection when the list refreshes', async () => {
    const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K, OLD_K] })} />)
    await flush()
    act(() => (el.querySelectorAll('[data-testid="knowledge-page-item"]')[1] as HTMLElement).click())
    act(() => root!.render(<ProjectPagesSection {...props({ knowledge: [kEntry('c', 'Newest', 3000), NEW_K, OLD_K] })} />))
    await flush()
    expect(el.querySelector('iframe[title="Older page"]')).not.toBeNull()
  })

  it('keeps the page selection across key-button switches', async () => {
    const over = { knowledge: [NEW_K, OLD_K], videos: [NEW_V] }
    const el = mount(<ProjectPagesSection {...props(over)} />)
    await flush()
    act(() => (el.querySelectorAll('[data-testid="knowledge-page-item"]')[1] as HTMLElement).click())
    await show({ ...over, tab: 'videos' })
    await show({ ...over, tab: 'pages' })
    expect(el.querySelector('[data-testid="knowledge-page-item"][aria-current="true"]')?.getAttribute('data-id')).toBe('a')
    expect(el.querySelector('iframe[title="Older page"]')).not.toBeNull()
  })

  it('video page lists videos with title, kind, length, created, LUFS and grade', async () => {
    const el = mount(<ProjectPagesSection {...props({ videos: [NEW_V, OLD_V], tab: 'videos' })} />)
    await flush()
    const items = Array.from(el.querySelectorAll('[data-testid="video-item"]'))
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('Newer video')
    expect(items[0].textContent).toContain('project-demo')
    expect(items[0].textContent).toContain('30')
    expect(items[0].textContent).toContain('-16.2')
    expect(items[0].textContent).toContain('7.5')
    expect(items[1].textContent).toContain('Older video')
    expect(items[1].textContent).toContain('blog-post')
    expect(items[1].querySelector('[data-col="lufs"]')?.textContent).toBe('-')
    expect(items[1].querySelector('[data-col="grade"]')?.textContent).toBe('-')
    expect(items[0].querySelector('[data-testid="video-thumb"]')?.textContent).toContain('Newer video')
    expect(items[0].querySelector('[data-testid="video-duration"]')?.textContent).toBe('0:30')
    expect(items[1].querySelector('[data-testid="video-duration"]')?.textContent).toBe('1:00')
    expect(items[0].getAttribute('aria-current')).toBe('true')
    expect(el.querySelector('[data-testid="video-player-frame"]')).not.toBeNull()
    expect(byTestId('project-home-video-title', el)?.textContent).toBe('Newer video')
    // VideosPane's Generate video + Regenerate… launch videos: no toolbar MacroButton, no selects
    expect(oldToolbar(el)).toEqual([])
    expect(generateBtn()?.getAttribute('data-kind')).toBe('video')
    expect(generateBtn()?.textContent).toBe('Generate video')
    expect(byTestId('project-home-regenerate', el)?.textContent).toBe('Regenerate…')
  })

  it('shows the selected video\'s SOURCES and QUALITY REPORT, "-" for null numbers and a cross for a failing check', async () => {
    const checked = vEntry('v3', 'Checked video', 3000, {
      sources: [{ claim: 'Runs locally', source: 'README.md', ref: 'Privacy' }],
      report: {
        lufs: null, truePeakDb: -1.2, speechS: null, readingGrade: 6,
        checks: [
          { id: 'net', ok: false, detail: 'Opens a WebSocket' },
          { id: 'len', ok: true, detail: 'Length matches (30s)' },
        ],
        bytes: 1,
      },
    })
    const el = mount(<ProjectPagesSection {...props({ videos: [checked, NEW_V], tab: 'videos' })} />)
    await flush()
    expect(byTestId('video-sources-count', el)?.textContent).toBe('1 claim')
    const source = byTestId('video-source', el)!
    expect(source.textContent).toContain('Runs locally')
    expect(source.textContent).toContain('README.md › Privacy')
    const report = byTestId('video-report', el)!
    expect(Array.from(report.querySelectorAll('[data-stat]')).map((s) => s.querySelector('[data-col="value"]')?.textContent)).toEqual([
      '-', '-1.2', '-', '6',
    ])
    const checks = Array.from(report.querySelectorAll('[data-testid="video-check"]'))
    expect(checks.map((c) => [c.getAttribute('data-ok'), c.textContent])).toEqual([
      ['false', 'Opens a WebSocket'],
      ['true', 'Length matches (30s)'],
    ])
    expect(checks[0].querySelector('[data-testid="video-check-icon"]')?.className).toContain('text-accent')
    expect(checks[1].querySelector('[data-testid="video-check-icon"]')?.className).toContain('text-sage-dark')
  })

  it('video entry with meta null shows its error line', async () => {
    const el = mount(<ProjectPagesSection {...props({ videos: [vEntry('bad', '', 5, {}, false)], tab: 'videos' })} />)
    await flush()
    expect(el.querySelector('[data-testid="video-item"]')?.textContent).toContain('bad meta')
  })

  it('each page has its own empty state with its starter cards', async () => {
    const onLaunch = vi.fn()
    const el = mount(<ProjectPagesSection {...props({ onLaunch })} />)
    expect(el.querySelector('iframe')).toBeNull()
    expect(macroBtn(el, 'builtin-project-home')).toBeNull()
    expect(macroBtn(el, 'builtin-demo-video')).toBeNull()
    const pages = byTestId('knowledge-page-empty', el)!
    act(() => byTestId('template-card-quick', pages.querySelector('[data-tpl="overview"]')!)!.click())
    expect(onLaunch.mock.calls).toEqual([[HOME_MACRO, OVERVIEW_LINES]])
    await show({ onLaunch, tab: 'videos' })
    const empty = byTestId('video-page-empty', el)!
    expect(byTestId('library-empty-eyebrow', empty)?.textContent).toBe('NO VIDEOS YET')
    expect(oldToolbar(el)).toEqual([])
    act(() => byTestId('template-card-customize', empty.querySelector('[data-tpl="demo"]')!)!.click())
    expect(byTestId('composer-title')?.textContent).toBe('Generate video')
    act(() => byTestId('composer-generate')!.click())
    expect(onLaunch.mock.calls).toEqual([[HOME_MACRO, OVERVIEW_LINES], [DEMO_MACRO, DEMO_LINES]])
  })

  it('neither pages nor videos render the old toolbar MacroButton, its selects or its extra input', async () => {
    const el = mount(<ProjectPagesSection {...props()} />)
    expect(oldToolbar(el)).toEqual([])
    await show({ knowledge: [NEW_K] })
    expect(oldToolbar(el)).toEqual([])
    await show({ tab: 'videos' })
    expect(oldToolbar(el)).toEqual([])
    await show({ videos: [NEW_V, OLD_V], tab: 'videos' })
    expect(el.querySelectorAll('[data-testid="video-item"]')).toHaveLength(2)
    expect(oldToolbar(el)).toEqual([])
  })

  describe('videos launch through the Generate composer', () => {
    it('Generate video opens the video composer and launches builtin-demo-video with its lines', async () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ videos: [NEW_V, OLD_V], onLaunch, tab: 'videos' })} />)
      await flush()
      act(() => generateBtn()!.click())
      expect(byTestId('composer-title')?.textContent).toBe('Generate video')
      act(() => (document.querySelector('[data-testid="composer-template"][data-tpl="blog"]') as HTMLElement).click())
      typeInto(byTestId('composer-target'), 'blog/launch.md')
      act(() => byTestId('composer-generate')!.click())
      expect(onLaunch.mock.calls).toEqual([
        [DEMO_MACRO, 'Video kind: Blog post\nVideo target: blog/launch.md\nVideo style: Professional\nVideo length: 60\nCharacter: off'],
      ])
      expect(byTestId('project-home-composer')).toBeNull()
      expect(el.querySelector('[data-testid="project-home-library"]')).not.toBeNull()
    })

    it('Regenerate… rebuilds the selected video in place from its meta: its lines end with Replace entry: <id>', async () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ videos: [NEW_V, OLD_V], onLaunch, tab: 'videos' })} />)
      await flush()
      act(() => (el.querySelectorAll('[data-testid="video-item"]')[1] as HTMLElement).click())
      act(() => byTestId('project-home-regenerate', el)!.click())
      expect(byTestId('composer-title')?.textContent).toBe('Regenerate “Older video”')
      expect(byTestId('composer-eyebrow')?.textContent).toBe('REBUILDING · v1')
      act(() => byTestId('composer-generate')!.click())
      // OLD_V: blog-post · Fun · 60s · no character
      expect(onLaunch.mock.calls).toEqual([
        [DEMO_MACRO, 'Video kind: Blog post\nVideo style: Fun\nVideo length: 60\nCharacter: off\nReplace entry: v1'],
      ])
    })

    it('gives VideosPane the video macro\'s job: a queued video build disables Generate video, a page build does not', async () => {
      const job = (macroId: string): MacroJobStatus => ({
        macroId, epicId: null, slug: 's', state: 'queued', status: 'queued', reason: null, startedAt: null, finishedAt: null,
      })
      const el = mount(<ProjectPagesSection {...props({ videos: [NEW_V], tab: 'videos', jobStatus: { 'builtin-project-home': job('builtin-project-home') } })} />)
      await flush()
      expect(generateBtn()!.disabled).toBe(false)
      expect(buildingMeta(el)).toBeUndefined()
      await show({ videos: [NEW_V], tab: 'videos', jobStatus: { 'builtin-demo-video': job('builtin-demo-video') } })
      expect(generateBtn()!.disabled).toBe(true)
      expect(buildingMeta(el)).toBe('Queued')
      // The building row is selected, so the title bar offers Open session instead of Regenerate….
      expect(byTestId('project-home-regenerate', el)).toBeNull()
      expect(byTestId('project-home-open-session', el)).not.toBeNull()
    })

    it('without the builtin-demo-video macro Generate video stays disabled', async () => {
      mount(<ProjectPagesSection {...props({ videos: [NEW_V], macros: [HOME_MACRO], tab: 'videos' })} />)
      await flush()
      expect(generateBtn()!.disabled).toBe(true)
    })

    it('keeps the video selection across key-button switches', async () => {
      const over = { knowledge: [NEW_K], videos: [NEW_V, OLD_V] }
      const el = mount(<ProjectPagesSection {...props({ ...over, tab: 'videos' })} />)
      await flush()
      act(() => (el.querySelectorAll('[data-testid="video-item"]')[1] as HTMLElement).click())
      await show({ ...over, tab: 'pages' })
      await show({ ...over, tab: 'videos' })
      expect(el.querySelector('[data-testid="video-item"][aria-current="true"]')?.getAttribute('data-id')).toBe('v1')
      expect(byTestId('project-home-video-title', el)?.textContent).toBe('Older video')
    })
  })

  describe('pages launch through the Generate composer', () => {
    it('Generate page opens the composer and launches builtin-project-home with its lines', async () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K, OLD_K], onLaunch })} />)
      await flush()
      act(() => generateBtn()!.click())
      expect(byTestId('composer-title')?.textContent).toBe('Generate page')
      act(() => (document.querySelector('[data-testid="composer-template"][data-tpl="how"]') as HTMLElement).click())
      act(() => byTestId('composer-generate')!.click())
      expect(onLaunch.mock.calls).toEqual([
        [HOME_MACRO, 'Page: How it works\nAudience: Contributors\nLength: In-depth\nRead from: README & docs, Source tree'],
      ])
      expect(byTestId('project-home-composer')).toBeNull()
      expect(el.querySelector('[data-testid="project-home-library"]')).not.toBeNull()
    })

    it('Regenerate… rebuilds the selected page in place: its lines end with Replace entry: <id>', async () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K, OLD_K], onLaunch })} />)
      await flush()
      act(() => (el.querySelectorAll('[data-testid="knowledge-page-item"]')[1] as HTMLElement).click())
      act(() => byTestId('project-home-regenerate', el)!.click())
      expect(byTestId('composer-title')?.textContent).toBe('Regenerate “Older page”')
      // id 'a' is no built-in kind, so it rebuilds as a Custom topic carrying meta.topic
      expect((byTestId('composer-topic') as HTMLInputElement).value).toBe('t')
      act(() => byTestId('composer-generate')!.click())
      expect(onLaunch.mock.calls).toEqual([
        [HOME_MACRO, 'Page: Custom topic: t\nAudience: Users\nLength: Standard\nRead from: README & docs, Source tree, Git log\nReplace entry: a'],
      ])
    })

    it('keeps the launched instructions within the 4000-char IPC cap by cutting Focus first', async () => {
      const onLaunch = vi.fn()
      mount(<ProjectPagesSection {...props({ knowledge: [kEntry('overview', 'Overview', 1000)], onLaunch })} />)
      await flush()
      act(() => byTestId('project-home-regenerate')!.click())
      typeInto(byTestId('composer-focus'), 'focus '.repeat(1000))
      act(() => byTestId('composer-generate')!.click())
      const sent = onLaunch.mock.calls[0][1] as string
      expect(sent.length).toBeLessThanOrEqual(4000)
      expect(sent.startsWith(`${OVERVIEW_LINES}\nfocus focus`)).toBe(true)
      expect(sent.endsWith('\nReplace entry: overview')).toBe(true)
    })

    it('gives PagesPane the page macro\'s job: a queued page build disables Generate page, a video build does not', async () => {
      const job = (macroId: string): MacroJobStatus => ({
        macroId, epicId: null, slug: 's', state: 'queued', status: 'queued', reason: null, startedAt: null, finishedAt: null,
      })
      const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], jobStatus: { 'builtin-demo-video': job('builtin-demo-video') } })} />)
      await flush()
      expect(generateBtn()!.disabled).toBe(false)
      expect(buildingMeta(el)).toBeUndefined()
      await show({ knowledge: [NEW_K], jobStatus: { 'builtin-project-home': job('builtin-project-home') } })
      expect(generateBtn()!.disabled).toBe(true)
      expect(buildingMeta(el)).toBe('Queued')
    })

    it('passes the page macro\'s last launch to PagesPane and reports new launches through onLaunched', async () => {
      const onLaunched = vi.fn()
      const launch = { title: 'Getting started', lines: ['Page: Custom topic: Getting started'], at: Date.now() }
      const job: MacroJobStatus = {
        macroId: 'builtin-project-home', epicId: 'e', slug: 's', state: 'queued', status: 'pending', reason: null, startedAt: null, finishedAt: null,
      }
      const el = mount(
        <ProjectPagesSection
          {...props({ knowledge: [NEW_K], onLaunched, launches: { 'builtin-project-home': launch }, jobStatus: { 'builtin-project-home': job } })}
        />,
      )
      await flush()
      expect(el.querySelector('[data-testid="project-home-building-row"] [data-col="title"]')?.textContent).toBe('Getting started')
      await show({ knowledge: [NEW_K], onLaunched, launches: { 'builtin-project-home': launch } })
      act(() => generateBtn()!.click())
      act(() => byTestId('composer-generate')!.click())
      expect(onLaunched.mock.calls).toEqual([
        ['builtin-project-home', { title: 'Overview', lines: OVERVIEW_LINES.split('\n'), at: expect.any(Number) }],
      ])
    })

    it('without the builtin-project-home macro Generate page stays disabled', async () => {
      mount(<ProjectPagesSection {...props({ knowledge: [NEW_K], macros: [DEMO_MACRO] })} />)
      await flush()
      expect(generateBtn()!.disabled).toBe(true)
    })
  })

  describe('tools tab', () => {
    const TOOL = '[data-testid="project-home-tool"]'
    const toolIds = (el: HTMLElement) => Array.from(el.querySelectorAll(TOOL)).map((b) => b.getAttribute('data-macro-id'))

    it('renders the Tools list for every macro but the two library builtins, only on the tools tab', async () => {
      const over = { macros: [...MACROS, REVIEW], videos: [NEW_V] }
      const el = mount(<ProjectPagesSection {...props({ ...over, tab: 'tools' })} />)
      expect(toolIds(el)).toEqual(['review-md'])
      expect(el.querySelector('[data-testid="project-home-add-tool"]')).not.toBeNull()
      expect(macroBtn(el, 'builtin-project-home')).toBeNull()
      expect(macroBtn(el, 'builtin-demo-video')).toBeNull()
      await show({ ...over, tab: 'videos' })
      expect(toolIds(el)).toEqual([])
      expect(el.querySelector('[data-testid="project-home-add-tool"]')).toBeNull()
      await show({ ...over, tab: 'pages' })
      expect(toolIds(el)).toEqual([])
    })

    it('has no hot-key strip on any tab: project-home macros live in the Tools list', async () => {
      const over = { macros: [...MACROS, REVIEW], knowledge: [NEW_K], videos: [NEW_V] }
      const el = mount(<ProjectPagesSection {...props(over)} />)
      for (const tab of ['pages', 'videos', 'tools']) {
        await show({ ...over, tab })
        expect(el.querySelector('[data-testid="project-home-hotkeys"]')).toBeNull()
        expect(el.querySelector('[data-testid="project-home-hotkey"]')).toBeNull()
      }
    })

    it('with only the library builtins the list is empty but keeps Add a tool and the footnote', () => {
      const el = mount(<ProjectPagesSection {...props({ tab: 'tools' })} />)
      expect(toolIds(el)).toEqual([])
      expect(el.querySelector('[data-testid="project-home-add-tool"]')).not.toBeNull()
      expect(el.querySelector('[data-testid="project-home-tools-footnote"]')?.textContent).toContain('Surface: Project Home')
    })

    it('does not wait on or report the pages load', () => {
      const el = mount(<ProjectPagesSection {...props({ macros: [...MACROS, REVIEW], tab: 'tools', loaded: false })} />)
      expect(el.querySelector('[data-testid="project-home-loading"]')).toBeNull()
      expect(toolIds(el)).toEqual(['review-md'])
      act(() => root!.render(<ProjectPagesSection {...props({ macros: [...MACROS, REVIEW], tab: 'tools', error: 'boom' })} />))
      expect(el.querySelector('[data-testid="project-home-load-error"]')).toBeNull()
      expect(toolIds(el)).toEqual(['review-md'])
    })

    it('threads jobStatus and onOpenSession to the competitor matrix view', () => {
      const matrixApi = vi.fn(() => new Promise(() => {}))
      ;(window as unknown as { api: { projectPages: unknown } }).api.projectPages = { matrix: matrixApi }
      const CM = macro({ id: 'builtin-competitor-matrix', label: 'Competitor matrix', surface: 'project-home' })
      const running: MacroJobStatus = {
        macroId: CM.id, epicId: 'e', slug: 's', state: 'running', status: 'running', reason: null, startedAt: null, finishedAt: null,
      }
      const el = mount(
        <ProjectPagesSection {...props({ cwd: '/p/x', macros: [...MACROS, CM], tab: 'tools', jobStatus: { [CM.id]: running }, onOpenSession: vi.fn() })} />,
      )
      expect(el.querySelector('[data-testid="competitor-matrix"]')?.getAttribute('data-has-session-handler')).toBe('true')
      expect(el.querySelector('[data-testid="competitor-matrix-status"]')?.textContent).toContain('Researching…')
      expect(matrixApi.mock.calls).toEqual([[{ cwd: '/p/x' }]])
    })

    it('launches the selected tool through onLaunch', () => {
      const onLaunch = vi.fn()
      const el = mount(<ProjectPagesSection {...props({ macros: [...MACROS, REVIEW], onLaunch, tab: 'tools' })} />)
      act(() => (el.querySelector('[data-testid="project-home-run-tool"]') as HTMLElement).click())
      expect(onLaunch.mock.calls).toEqual([[REVIEW]])
    })
  })

  it('disables Generate page and Generate video while launching', async () => {
    const lists = { knowledge: [NEW_K], videos: [NEW_V] }
    mount(<ProjectPagesSection {...props({ ...lists, launching: 'builtin-project-home' })} />)
    expect(generateBtn()!.disabled).toBe(true)
    expect(generateBtn()!.textContent).toBe('Starting…')
    await show({ ...lists, launching: 'builtin-demo-video', tab: 'videos' })
    expect(generateBtn()!.getAttribute('data-kind')).toBe('video')
    expect(generateBtn()!.disabled).toBe(true)
    expect(generateBtn()!.textContent).toBe('Starting…')
  })

  describe('job status', () => {
    const st = (over: Partial<MacroJobStatus>): MacroJobStatus => ({
      macroId: 'builtin-demo-video', epicId: 'epic-1', slug: 's', state: 'queued', status: 'queued',
      reason: null, startedAt: null, finishedAt: null, ...over,
    })
    const render = async (s: MacroJobStatus, onOpenSession = vi.fn()) => {
      const el = mount(<ProjectPagesSection {...props({ jobStatus: { [s.macroId]: s }, onOpenSession, tab: 'videos' })} />)
      await flush()
      return el
    }
    const line = (el: HTMLElement) => el.querySelector('[data-testid="project-home-job-status"]') as HTMLElement

    it('queued: the first video builds as a selected building row with the BuildingPanel; Generate video disabled', async () => {
      const onOpen = vi.fn()
      const el = await render(st({ state: 'queued' }), onOpen)
      expect(byTestId('video-page-empty', el)).toBeNull()
      expect(buildingMeta(el)).toBe('Queued')
      expect(byTestId('project-home-building', el)?.getAttribute('data-state')).toBe('queued')
      expect(line(el)).toBeNull()
      expect(generateBtn()!.disabled).toBe(true)
      expect(generateBtn()!.textContent).toBe('Generate video')
      act(() => byTestId('project-home-building-session', el)!.click())
      expect(onOpen.mock.calls).toEqual([['epic-1']])
    })
    it('running: Building… started ago', async () => {
      const el = await render(st({ state: 'running', startedAt: new Date(Date.now() - 120_000).toISOString() }))
      expect(buildingMeta(el)).toBe('Building… started 2m ago')
      expect(byTestId('project-home-building-elapsed', el)?.textContent).toBe('Started 2m ago')
    })
    it('done: button enabled, nothing building and no status line', async () => {
      const el = await render(st({ state: 'done', finishedAt: new Date(Date.now() - 60_000).toISOString() }))
      expect(line(el)).toBeNull()
      expect(buildingMeta(el)).toBeUndefined()
      expect(byTestId('video-page-empty', el)).not.toBeNull()
      expect((byTestId('template-card-quick', el) as HTMLButtonElement).disabled).toBe(false)
    })
    it('failed: reason with role=alert, no session link without epicId', async () => {
      const el = await render(st({ state: 'failed', reason: 'timed out after 30m', epicId: null }))
      expect(line(el).textContent).toBe('Failed: timed out after 30m')
      expect(line(el).getAttribute('role')).toBe('alert')
      expect(el.querySelector('[data-testid="project-home-job-session"]')).toBeNull()
    })
  })

  describe('rename and delete', () => {
    const rename = vi.fn()
    const del = vi.fn()
    beforeEach(() => {
      rename.mockReset().mockResolvedValue({ ok: true, title: 'x' })
      del.mockReset().mockResolvedValue({ ok: true })
      ;(window as any).api.projectPages = { rename, delete: del }
      useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    })
    const mountK = async () => {
      const el = mount(<ProjectPagesSection {...props({ cwd: '/proj', knowledge: [NEW_K, OLD_K] })} />)
      await flush()
      return el
    }
    const row = (el: HTMLElement, i: number) => el.querySelectorAll('li')[i] as HTMLElement
    const tid = (r: HTMLElement, id: string) => r.querySelector(`[data-testid="${id}"]`) as HTMLElement
    const typeTitle = (input: HTMLInputElement, v: string) => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setValue.call(input, v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const enter = (input: HTMLInputElement) =>
      act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await Promise.resolve()
      })

    it('shows Rename and Delete under the selected row only', async () => {
      const el = await mountK()
      expect(el.querySelectorAll('[data-testid="entry-rename"]')).toHaveLength(1)
      expect(tid(row(el, 0), 'entry-rename')).not.toBeNull()
      expect(tid(row(el, 1), 'entry-rename')).toBeNull()
      act(() => (el.querySelectorAll('[data-testid="knowledge-page-item"]')[1] as HTMLElement).click())
      expect(tid(row(el, 0), 'entry-rename')).toBeNull()
      expect(tid(row(el, 1), 'entry-rename')).not.toBeNull()
      expect(tid(row(el, 1), 'entry-delete')).not.toBeNull()
    })

    it('Enter saves the inline title edit via projectPages.rename', async () => {
      const el = await mountK()
      act(() => (el.querySelectorAll('[data-testid="knowledge-page-item"]')[1] as HTMLElement).click())
      act(() => tid(row(el, 1), 'entry-rename').click())
      const input = tid(row(el, 1), 'entry-rename-input') as HTMLInputElement
      expect(input.value).toBe('Older page')
      typeTitle(input, '  Renamed  ')
      await enter(input)
      expect(rename).toHaveBeenCalledWith('/proj', 'knowledge', 'a', 'Renamed')
      expect(tid(row(el, 1), 'entry-rename-input')).toBeNull()
    })

    it('Delete asks to confirm, then calls projectPages.delete', async () => {
      const el = await mountK()
      act(() => tid(row(el, 0), 'entry-delete').click())
      expect(row(el, 0).textContent).toContain('Delete this page?')
      expect(del).not.toHaveBeenCalled()
      await act(async () => {
        tid(row(el, 0), 'entry-delete-confirm').click()
        await Promise.resolve()
      })
      expect(del).toHaveBeenCalledWith('/proj', 'knowledge', 'b')
    })

    it('cancel leaves the entry alone', async () => {
      const el = await mountK()
      act(() => tid(row(el, 0), 'entry-delete').click())
      act(() => tid(row(el, 0), 'entry-delete-cancel').click())
      expect(del).not.toHaveBeenCalled()
      expect(tid(row(el, 0), 'entry-delete')).not.toBeNull()
    })

    it('failures surface as an error toast', async () => {
      rename.mockRejectedValue(new Error('meta.json invalid'))
      del.mockRejectedValue(new Error('entry not found'))
      const el = await mountK()
      act(() => tid(row(el, 0), 'entry-rename').click())
      const input = tid(row(el, 0), 'entry-rename-input') as HTMLInputElement
      typeTitle(input, 'New')
      await enter(input)
      // the failed rename keeps row 0's input open: select row 1 by id
      act(() => (el.querySelector('[data-testid="knowledge-page-item"][data-id="a"]') as HTMLElement).click())
      act(() => tid(row(el, 1), 'entry-delete').click())
      await act(async () => {
        tid(row(el, 1), 'entry-delete-confirm').click()
        await Promise.resolve()
      })
      const msgs = useToast.getState().toasts.map((t) => [t.kind, t.message])
      expect(msgs).toEqual([
        ['error', 'Rename failed: meta.json invalid'],
        ['error', 'Delete failed: entry not found'],
      ])
    })

    it('video rows ask "Delete this video?" and delete through projectPages.delete with kind video', async () => {
      const el = mount(<ProjectPagesSection {...props({ cwd: '/proj', videos: [NEW_V, OLD_V], tab: 'videos' })} />)
      await flush()
      const first = el.querySelector('ul[aria-label="Videos"] > li') as HTMLElement
      act(() => tid(first, 'entry-delete').click())
      expect(first.textContent).toContain('Delete this video?')
      await act(async () => {
        tid(first, 'entry-delete-confirm').click()
        await Promise.resolve()
      })
      expect(del).toHaveBeenCalledWith('/proj', 'video', 'v2')
    })

    it('shows no actions without a cwd', async () => {
      const el = mount(<ProjectPagesSection {...props({ knowledge: [NEW_K] })} />)
      await flush()
      expect(el.querySelector('[data-testid="entry-rename"]')).toBeNull()
    })
  })
})
