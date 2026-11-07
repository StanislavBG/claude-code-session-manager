// @vitest-environment jsdom
/**
 * LibraryEmptyState — Project Home v2's starter gallery (DESIGN_SPEC §4, renders 07-empty-pages and
 * 08-empty-videos): the component on its own, both panes' empty state (the quick-generate payload,
 * Name a topic and Customize opening the composer) and ProjectHome's TIP link to the Tools tab.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LibraryEmptyState, type LibraryEmptyStateProps } from '../LibraryEmptyState'
import { PagesPane, type PagesPaneProps } from '../PagesPane'
import { VideosPane, type VideosPaneProps } from '../VideosPane'
import {
  PAGE_TEMPLATES,
  VIDEO_TEMPLATES,
  pageDefaults,
  pagePromptLines,
  videoDefaults,
  videoPromptLines,
} from '../composerTemplates'
import { ProjectHome } from '../../ProjectHome'
import { useToast } from '../../../../../state/toast'
import { useSessions } from '../../../../../state/sessions'
import { __resetMacrosCacheForTests } from '../../../../../lib/useMacros'
import type { Macro } from '../../../../../../preload/api'

// ProjectHome's launches go through this spy instead of the real dispatch path (only ProjectHome imports it).
const launchSpy = vi.hoisted(() => vi.fn())
vi.mock('../../../../../lib/useMacroLaunch', () => ({
  useMacroLaunch: () => ({ launch: launchSpy, launching: null, cwd: '/proj' }),
}))

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(el: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}
const rerender = (el: ReactElement) => act(() => root!.render(el))

/** The composer portals into document.body, so lookups search the whole document. */
const tid = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const texts = (id: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll(`[data-testid="${id}"]`)).map((n) => n.textContent)
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
const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="template-card"]'))
const card = (tplId: string) => document.querySelector<HTMLElement>(`[data-testid="template-card"][data-tpl="${tplId}"]`)!
const quick = (tplId: string) => tid('template-card-quick', card(tplId)) as HTMLButtonElement
const customize = (tplId: string) => tid('template-card-customize', card(tplId)) as HTMLButtonElement
const preview = (tplId: string) => tid('template-card-preview', card(tplId))!
const quickLabels = () => cards().map((c) => tid('template-card-quick', c)?.textContent)
/** The composer's selected `START FROM` template. */
const pickedTemplate = () =>
  document.querySelector('[data-testid="composer-template"][aria-pressed="true"]')?.getAttribute('data-tpl')

const PAGE_TEXT =
  'Pages explain the project in writing, grounded in what the builder actually reads. Each starting point below is a pre-built configuration: generate it as-is, or customize it first.'
const VIDEO_TEXT =
  'Videos are short, self-contained animations — 30 seconds or a minute. Each starting point below is a pre-built configuration: generate it as-is, or customize it first.'
const TIP_TEXT =
  "Generated pages and videos are only as good as the docs behind them. If they're messy, run Review MD network in Tools first."

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
const DEMO: Macro = { ...HOME, id: 'builtin-demo-video', label: 'Demo Video', agentName: 'demo-video-builder' }

/** Template defaults as prompt lines, joined (DESIGN_SPEC §3). */
const OVERVIEW_LINES = 'Page: Overview\nAudience: Newcomers\nLength: Standard\nRead from: README & docs, Source tree, Git log'
const START_LINES =
  'Page: Custom topic: Getting started: install, first run, key commands\nAudience: Newcomers\nLength: Brief\nRead from: README & docs, Source tree'
const FAQ_LINES = 'Page: FAQ\nAudience: Newcomers\nLength: Brief\nRead from: README & docs'
const DEMO_LINES = 'Video kind: Project demo\nVideo style: Auto\nVideo length: 30\nCharacter: on'
const FEATURE_LINES =
  'Video kind: Feature\nVideo target: Scheduler / PRD queue\nVideo style: Kinetic typography\nVideo length: 30\nCharacter: off'
const WHITEBOARD_LINES = 'Video kind: Project demo\nVideo style: Animated whiteboard\nVideo length: 60\nCharacter: on'

function emptyProps(over: Partial<LibraryEmptyStateProps> = {}): LibraryEmptyStateProps {
  return { kind: 'page', onQuick: vi.fn(), onCustomize: vi.fn(), onGoTools: vi.fn(), ...over }
}

describe('LibraryEmptyState', () => {
  it('pages: NO PAGES YET, the serif title, the spec text and one card per page template, in order', () => {
    const el = mount(<LibraryEmptyState {...emptyProps()} />)
    const empty = tid('knowledge-page-empty', el)!
    expect(empty.getAttribute('data-kind')).toBe('page')
    expect(tid('video-page-empty')).toBeNull()
    expect(tid('library-empty-eyebrow', empty)?.textContent).toBe('NO PAGES YET')
    const title = tid('library-empty-title', empty)!
    expect(title.textContent).toBe('Start this project’s library')
    expect(title.classList.contains('font-serif')).toBe(true)
    expect(title.classList.contains('text-[30px]')).toBe(true)
    expect(tid('library-empty-text', empty)?.textContent).toBe(PAGE_TEXT)
    expect(cards().map((c) => c.getAttribute('data-tpl'))).toEqual(PAGE_TEMPLATES.map((t) => t.id))
    expect(cards().map((c) => col(c, 'name'))).toEqual(PAGE_TEMPLATES.map((t) => t.name))
    expect(cards().map((c) => col(c, 'blurb'))).toEqual(PAGE_TEMPLATES.map((t) => t.blurb))
  })

  it('a page card: 104px preview strip (eyebrow + up to 4 covers), name, blurb, preset line, primary and Customize', () => {
    mount(<LibraryEmptyState {...emptyProps()} />)
    const strip = preview('overview')
    expect(strip.classList.contains('h-[104px]')).toBe(true)
    expect(tid('template-card-eyebrow', strip)?.textContent).toBe('PAGE · OVERVIEW')
    expect(texts('template-card-line', strip)).toEqual(['What it is', 'Who it’s for', 'Key features', 'Structure'])
    expect(col(card('overview'), 'name')).toBe('Overview')
    expect(col(card('overview'), 'blurb')).toBe('What it is, who it’s for, key features, how to run it.')
    expect(col(card('overview'), 'preset')).toBe('newcomers · standard')
    expect(col(card('how'), 'preset')).toBe('contributors · in-depth')
    expect(tid('template-card-eyebrow', preview('how'))?.textContent).toBe('PAGE · HOW IT WORKS')
    expect(tid('template-card-eyebrow', preview('start'))?.textContent).toBe('PAGE · CUSTOM TOPIC')
    expect(texts('template-card-line', preview('custom'))).toEqual(['Shaped by your topic'])
    expect(quick('overview').textContent).toBe('Generate')
    expect(customize('overview').textContent).toBe('Customize')
    for (const c of cards()) expect(texts('template-card-line', c).length).toBeLessThanOrEqual(4)
  })

  it('the custom page template reads Name a topic and asks for the composer; every other primary reads Generate and quick-launches', () => {
    const onQuick = vi.fn()
    const onCustomize = vi.fn()
    mount(<LibraryEmptyState {...emptyProps({ onQuick, onCustomize })} />)
    expect(quickLabels()).toEqual(['Generate', 'Generate', 'Generate', 'Generate', 'Generate', 'Name a topic'])
    click(quick('custom'))
    expect(onCustomize.mock.calls).toEqual([['custom']])
    expect(onQuick).not.toHaveBeenCalled()
    click(quick('start'))
    click(quick('overview'))
    expect(onQuick.mock.calls).toEqual([['start'], ['overview']])
    expect(onCustomize.mock.calls).toEqual([['custom']])
  })

  it('Customize asks for the composer on that template', () => {
    const onQuick = vi.fn()
    const onCustomize = vi.fn()
    mount(<LibraryEmptyState {...emptyProps({ onQuick, onCustomize })} />)
    click(customize('faq'))
    click(customize('custom'))
    expect(onCustomize.mock.calls).toEqual([['faq'], ['custom']])
    expect(onQuick).not.toHaveBeenCalled()
  })

  it('videos: NO VIDEOS YET, its title and text, one card per video template, each preview in its style colours', () => {
    const onQuick = vi.fn()
    const el = mount(<LibraryEmptyState {...emptyProps({ kind: 'video', onQuick })} />)
    const empty = tid('video-page-empty', el)!
    expect(empty.getAttribute('data-kind')).toBe('video')
    expect(tid('knowledge-page-empty')).toBeNull()
    expect(tid('library-empty-eyebrow', empty)?.textContent).toBe('NO VIDEOS YET')
    expect(tid('library-empty-title', empty)?.textContent).toBe('Show the project in under a minute')
    expect(tid('library-empty-text', empty)?.textContent).toBe(VIDEO_TEXT)
    expect(cards().map((c) => c.getAttribute('data-tpl'))).toEqual(VIDEO_TEMPLATES.map((t) => t.id))
    expect(quickLabels()).toEqual(VIDEO_TEMPLATES.map(() => 'Generate'))
    expect(VIDEO_TEMPLATES.map((t) => preview(t.id).getAttribute('data-style'))).toEqual(VIDEO_TEMPLATES.map((t) => t.style))
    expect(preview('demo').classList.contains('bg-bg-elev')).toBe(true)
    expect(preview('feature').classList.contains('bg-accent')).toBe(true)
    expect(preview('blog').classList.contains('bg-fg')).toBe(true)
    expect(preview('blog').classList.contains('font-serif')).toBe(true)
    expect(preview('whiteboard').classList.contains('bg-bg-hi')).toBe(true)
    expect(tid('template-card-eyebrow', preview('feature'))?.textContent).toBe('30 S · KINETIC TYPOGRAPHY')
    expect(tid('template-card-eyebrow', preview('blog'))?.textContent).toBe('60 S · PROFESSIONAL')
    expect(texts('template-card-line', preview('whiteboard'))).toEqual([
      'The pieces',
      'How they connect',
      'One request, end to end',
      'Recap',
    ])
    expect(col(card('demo'), 'preset')).toBe('project demo · 30s')
    expect(col(card('feature'), 'preset')).toBe('feature · 30s')
    expect(col(card('blog'), 'preset')).toBe('blog post · 60s')
    // The video Custom card is a brief, not a topic: its defaults launch as-is.
    click(quick('custom'))
    expect(onQuick.mock.calls).toEqual([['custom']])
  })

  it('lays the cards out as an auto-fill grid (min 230px, gap 14px) in a 1000px centered column', () => {
    mount(<LibraryEmptyState {...emptyProps()} />)
    const grid = tid('library-empty-grid')!
    expect(grid.style.gridTemplateColumns.replace(/\s/g, '')).toBe('repeat(auto-fill,minmax(230px,1fr))')
    expect(grid.classList.contains('gap-3.5')).toBe(true)
    const column = grid.parentElement!
    expect(column.classList.contains('max-w-[1000px]')).toBe(true)
    expect(column.classList.contains('mx-auto')).toBe(true)
  })

  it('the TIP strip carries the spec text; its Review MD network link calls onGoTools', () => {
    const onGoTools = vi.fn()
    mount(<LibraryEmptyState {...emptyProps({ onGoTools })} />)
    const tip = tid('library-empty-tip')!
    expect(tid('library-empty-tip-label', tip)?.textContent).toBe('TIP')
    expect(tid('library-empty-tip-text', tip)?.textContent).toBe(TIP_TEXT)
    const link = tid('library-empty-tools', tip)!
    expect(link.textContent).toBe('Review MD network')
    click(link)
    expect(onGoTools).toHaveBeenCalledTimes(1)
  })

  it('without onGoTools the TIP keeps its text with no dead link', () => {
    mount(<LibraryEmptyState {...emptyProps({ onGoTools: undefined })} />)
    expect(tid('library-empty-tip-text')?.textContent).toBe(TIP_TEXT)
    expect(tid('library-empty-tools')).toBeNull()
  })

  it('disabled: both buttons on every card are disabled with the reason as their title; the Tools link stays live', () => {
    const onGoTools = vi.fn()
    mount(<LibraryEmptyState {...emptyProps({ disabled: true, disabledTitle: 'No macro', onGoTools })} />)
    for (const c of cards()) {
      for (const id of ['template-card-quick', 'template-card-customize']) {
        const button = tid(id, c) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.title).toBe('No macro')
      }
    }
    click(tid('library-empty-tools'))
    expect(onGoTools).toHaveBeenCalledTimes(1)
  })

  it('starting: only the card pressed last reads Starting… while its launch is in flight', () => {
    const props = emptyProps()
    mount(<LibraryEmptyState {...props} />)
    click(quick('faq'))
    rerender(<LibraryEmptyState {...props} disabled starting />)
    expect(quickLabels()).toEqual(['Generate', 'Generate', 'Starting…', 'Generate', 'Generate', 'Name a topic'])
    rerender(<LibraryEmptyState {...props} />)
    expect(quick('faq').textContent).toBe('Generate')
  })

  it('renders a notice (a failed build) between the heading and the cards', () => {
    mount(<LibraryEmptyState {...emptyProps({ notice: <span data-testid="the-notice">Failed: boom</span> })} />)
    const notice = tid('the-notice')!
    const heading = tid('library-empty-title')!
    const grid = tid('library-empty-grid')!
    expect(heading.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(notice.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('PagesPane / VideosPane empty state', () => {
  const pagesProps = (over: Partial<PagesPaneProps> = {}): PagesPaneProps => ({
    cwd: '/proj',
    entries: [],
    macro: HOME,
    launching: null,
    onLaunch: vi.fn(),
    ...over,
  })
  const videosProps = (over: Partial<VideosPaneProps> = {}): VideosPaneProps => ({
    cwd: '/proj',
    entries: [],
    macro: DEMO,
    launching: null,
    onLaunch: vi.fn(),
    ...over,
  })

  it('PagesPane renders the page gallery in place of the old one-line empty state', () => {
    mount(<PagesPane {...pagesProps()} />)
    const empty = tid('knowledge-page-empty')!
    expect(tid('library-empty-eyebrow', empty)?.textContent).toBe('NO PAGES YET')
    expect(empty.textContent).not.toContain('No knowledge pages yet.')
    expect(cards()).toHaveLength(PAGE_TEMPLATES.length)
    expect(tid('project-home-generate')).toBeNull()
    expect(tid('project-home-library')).toBeNull()
  })

  it('Generate launches a page template with its pageDefaults lines, without opening the composer', () => {
    const onLaunch = vi.fn()
    const onLaunched = vi.fn()
    mount(<PagesPane {...pagesProps({ onLaunch, onLaunched })} />)
    click(quick('overview'))
    expect(tid('project-home-composer')).toBeNull()
    expect(onLaunch.mock.calls).toEqual([[HOME, OVERVIEW_LINES]])
    expect(onLaunched.mock.calls).toHaveLength(1)
    expect(onLaunched.mock.calls[0][0]).toBe('builtin-project-home')
    expect(onLaunched.mock.calls[0][1]).toMatchObject({ title: 'Overview', lines: OVERVIEW_LINES.split('\n') })
    click(quick('start'))
    expect(tid('project-home-composer')).toBeNull()
    expect(onLaunch.mock.calls[1]).toEqual([HOME, START_LINES])
    expect(onLaunched.mock.calls[1][1]).toMatchObject({ title: 'Getting started' })
  })

  it('every Generate sends exactly its template defaults', () => {
    const onPage = vi.fn()
    mount(<PagesPane {...pagesProps({ onLaunch: onPage })} />)
    const quickPages = PAGE_TEMPLATES.filter((t) => t.id !== 'custom')
    for (const t of quickPages) click(quick(t.id))
    expect(onPage.mock.calls).toEqual(
      quickPages.map((t) => [HOME, pagePromptLines(t.id, pageDefaults(t.id)).join('\n')]),
    )
    const onVideo = vi.fn()
    rerender(<VideosPane {...videosProps({ onLaunch: onVideo })} />)
    for (const t of VIDEO_TEMPLATES) click(quick(t.id))
    expect(onVideo.mock.calls).toEqual(VIDEO_TEMPLATES.map((t) => [DEMO, videoPromptLines(videoDefaults(t.id)).join('\n')]))
    expect(tid('project-home-composer')).toBeNull()
  })

  it('Name a topic opens the composer on Custom topic; nothing launches until a topic is named', () => {
    const onLaunch = vi.fn()
    mount(<PagesPane {...pagesProps({ onLaunch })} />)
    click(quick('custom'))
    expect(onLaunch).not.toHaveBeenCalled()
    expect(tid('project-home-composer')).not.toBeNull()
    expect(tid('composer-title')?.textContent).toBe('Generate page')
    expect(tid('composer-eyebrow')?.textContent).toBe('TEMPLATE · CUSTOM TOPIC')
    expect(pickedTemplate()).toBe('custom')
    expect((tid('composer-generate') as HTMLButtonElement).disabled).toBe(true)
    type(tid('composer-topic'), 'The security model')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([
      [HOME, 'Page: Custom topic: The security model\nAudience: Users\nLength: Standard\nRead from: README & docs, Source tree, Git log'],
    ])
  })

  it('Customize opens the composer on that page template', () => {
    const onLaunch = vi.fn()
    mount(<PagesPane {...pagesProps({ onLaunch })} />)
    click(customize('faq'))
    expect(onLaunch).not.toHaveBeenCalled()
    expect(tid('composer-eyebrow')?.textContent).toBe('TEMPLATE · FAQ')
    expect(pickedTemplate()).toBe('faq')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls).toEqual([[HOME, FAQ_LINES]])
    expect(tid('project-home-composer')).toBeNull()
  })

  it('VideosPane: the video gallery; Generate launches videoDefaults lines, Customize opens the composer on that template', () => {
    const onLaunch = vi.fn()
    mount(<VideosPane {...videosProps({ onLaunch })} />)
    const empty = tid('video-page-empty')!
    expect(tid('library-empty-eyebrow', empty)?.textContent).toBe('NO VIDEOS YET')
    expect(empty.textContent).not.toContain('No videos yet.')
    expect(tid('project-home-generate')).toBeNull()
    click(quick('demo'))
    click(quick('feature'))
    expect(tid('project-home-composer')).toBeNull()
    expect(onLaunch.mock.calls).toEqual([
      [DEMO, DEMO_LINES],
      [DEMO, FEATURE_LINES],
    ])
    click(customize('whiteboard'))
    expect(tid('composer-title')?.textContent).toBe('Generate video')
    expect(tid('composer-eyebrow')?.textContent).toBe('TEMPLATE · WHITEBOARD EXPLAINER')
    expect(pickedTemplate()).toBe('whiteboard')
    click(tid('composer-generate'))
    expect(onLaunch.mock.calls[2]).toEqual([DEMO, WHITEBOARD_LINES])
  })

  it('a missing macro disables every card with the reason; a launch in flight disables them and labels its card Starting…', () => {
    mount(<PagesPane {...pagesProps({ macro: undefined })} />)
    expect(quick('overview').disabled).toBe(true)
    expect(customize('overview').disabled).toBe(true)
    expect(quick('overview').title).toBe('The built-in Project Home macro is not available for this project')
    rerender(<PagesPane {...pagesProps()} />)
    expect(quick('overview').disabled).toBe(false)
    click(quick('faq'))
    rerender(<PagesPane {...pagesProps({ launching: 'builtin-project-home' })} />)
    expect(quick('faq').textContent).toBe('Starting…')
    expect(quick('faq').disabled).toBe(true)
    expect(customize('faq').disabled).toBe(true)
    rerender(<PagesPane {...pagesProps({ launching: 'some-tool' })} />)
    expect(quick('faq').textContent).toBe('Generate')
    expect(quick('faq').disabled).toBe(true)
  })

  it('both panes hand onGoTools to the TIP link', () => {
    const onGoTools = vi.fn()
    mount(<PagesPane {...pagesProps({ onGoTools })} />)
    click(tid('library-empty-tools', tid('knowledge-page-empty')!))
    rerender(<VideosPane {...videosProps({ onGoTools })} />)
    click(tid('library-empty-tools', tid('video-page-empty')!))
    expect(onGoTools).toHaveBeenCalledTimes(2)
  })
})

describe('ProjectHome empty library', () => {
  const PAGES = { knowledge: [], videos: [], html: null, mtimeMs: null, demoVideo: null }

  beforeEach(() => {
    launchSpy.mockReset()
    __resetMacrosCacheForTests()
    useToast.setState({ toasts: [], history: [], unreadCount: 0 })
    useSessions.setState({ tabs: [{ id: 't1', cwd: '/proj' } as never], activeTabId: 't1' })
    ;(window as unknown as { api: unknown }).api = {
      config: { readText: vi.fn(async () => ({ exists: false, text: '', mtimeMs: 0, error: null, truncated: false })) },
      schedule: { listPrds: vi.fn(async () => []), onState: vi.fn(() => () => {}) },
      macros: { list: vi.fn(async () => [HOME, DEMO]), onChanged: vi.fn(() => () => {}), jobStatus: vi.fn(async () => []) },
      projectPages: {
        get: vi.fn(async () => PAGES),
        watch: vi.fn(async () => undefined),
        unwatch: vi.fn(async () => undefined),
        onChanged: vi.fn(() => () => {}),
        rename: vi.fn(),
        delete: vi.fn(),
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
  const sectionTab = () => tid('project-home-section')?.getAttribute('data-tab')
  const pressedKeys = () =>
    Array.from(document.querySelectorAll('[data-testid="project-home-key"][aria-pressed="true"]')).map((k) =>
      k.getAttribute('data-tab'),
    )

  it('the TIP link switches Project Home to the Tools tab, from Pages and from Videos', async () => {
    await mountHome()
    expect(sectionTab()).toBe('pages')
    click(tid('library-empty-tools', tid('knowledge-page-empty')!))
    expect(sectionTab()).toBe('tools')
    expect(pressedKeys()).toEqual(['tools'])
    click(document.querySelector<HTMLElement>('[data-testid="project-home-key"][data-tab="videos"]'))
    expect(sectionTab()).toBe('videos')
    click(tid('library-empty-tools', tid('video-page-empty')!))
    expect(sectionTab()).toBe('tools')
    expect(pressedKeys()).toEqual(['tools'])
  })

  it('a card Generate launches through ProjectHome with the template defaults', async () => {
    await mountHome()
    click(quick('overview'))
    expect(launchSpy.mock.calls).toEqual([[HOME, OVERVIEW_LINES]])
  })
})
