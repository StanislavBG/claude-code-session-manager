// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { BuildingPanel, failureShown, useJobSettled, type BuildingPanelProps, type BuildLaunch } from '../BuildingPanel'
import type { MacroJobStatus } from '../../../../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(node))
  return container
}
const rerender = (node: React.ReactElement) => act(() => root!.render(node))
const tid = (id: string, scope: ParentNode = document) => scope.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const texts = (id: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll(`[data-testid="${id}"]`)).map((n) => n.textContent)
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()

const job = (over: Partial<MacroJobStatus> = {}): MacroJobStatus => ({
  macroId: 'builtin-demo-video',
  epicId: 'epic-1',
  slug: 'demo-video-build-1',
  state: 'queued',
  status: 'pending',
  reason: null,
  startedAt: null,
  finishedAt: null,
  ...over,
})

const VIDEO_LINES = [
  'Video kind: Project demo',
  'Video style: Animated whiteboard',
  'Video length: 60',
  'Character: on',
  'Draw the main process and renderer',
]
const PAGE_LINES = ['Page: Overview', 'Audience: Newcomers', 'Length: Standard', 'Read from: README & docs']

const PAGE_TEXT =
  "The project-home-builder agent is reading the project. It saves the page with one project_page_write call, and it shows up here when it's done — you can keep working meanwhile."
const videoText = (len: string) =>
  `The demo-video-builder agent is writing ${len} animation. Before it’s saved it is checked for length, loudness and any network access.`

function panel(over: Partial<BuildingPanelProps> = {}) {
  return <BuildingPanel kind="video" title="How it works, on a whiteboard" lines={VIDEO_LINES} jobStatus={job()} {...over} />
}

describe('BuildingPanel', () => {
  it('queued: pulse + QUEUED, the serif title, the video explanation, a 4px bar, the sent lines and Waiting to start', () => {
    mount(panel({ onOpenSession: vi.fn() }))
    const el = tid('project-home-building')!
    expect(el.getAttribute('data-state')).toBe('queued')
    expect(tid('project-home-building-state', el)?.textContent).toBe('QUEUED')
    expect(tid('project-home-building-pulse', tid('project-home-building-state', el)!)).not.toBeNull()
    const title = tid('project-home-building-title', el)!
    expect(title.textContent).toBe('How it works, on a whiteboard')
    expect(title.className).toContain('font-serif')
    expect(tid('project-home-building-text', el)?.textContent).toBe(videoText('a one-minute'))
    const bar = tid('project-home-building-bar', el)!
    expect(bar.className).toContain('h-[4px]')
    expect(bar.getAttribute('role')).toBe('progressbar')
    const box = tid('project-home-building-lines', el)!
    expect(box.firstElementChild?.textContent).toBe('Sent to the builder')
    expect(texts('project-home-building-line', box)).toEqual(VIDEO_LINES)
    expect(tid('project-home-building-elapsed', el)?.textContent).toBe('Waiting to start')
  })

  it('running: BUILDING and Started <ago>; Open session calls onOpenSession with the job epic', () => {
    const onOpenSession = vi.fn()
    mount(panel({ jobStatus: job({ state: 'running', status: 'running', startedAt: isoAgo(60_000) }), onOpenSession }))
    const el = tid('project-home-building')!
    expect(el.getAttribute('data-state')).toBe('running')
    expect(tid('project-home-building-state', el)?.textContent).toBe('BUILDING')
    expect(tid('project-home-building-elapsed', el)?.textContent).toBe('Started 1m ago')
    const open = tid('project-home-building-session', el)!
    expect(open.textContent).toBe('Open session')
    act(() => open.click())
    expect(onOpenSession.mock.calls).toEqual([['epic-1']])
  })

  it('a 30-second video says so; a page uses the page builder explanation', () => {
    mount(panel({ lines: VIDEO_LINES.map((l) => (l === 'Video length: 60' ? 'Video length: 30' : l)) }))
    expect(tid('project-home-building-text')?.textContent).toBe(videoText('a 30-second'))
    rerender(<BuildingPanel kind="page" title="Overview" lines={PAGE_LINES} jobStatus={job({ macroId: 'builtin-project-home' })} />)
    expect(tid('project-home-building-text')?.textContent).toBe(PAGE_TEXT)
    expect(texts('project-home-building-line')).toEqual(PAGE_LINES)
  })

  it('without the sent lines (an app reload) omits the box; a video of unknown length gets no length word', () => {
    mount(panel({ title: 'Demo Video', lines: undefined }))
    expect(tid('project-home-building-title')?.textContent).toBe('Demo Video')
    expect(tid('project-home-building-lines')).toBeNull()
    expect(tid('project-home-building-text')?.textContent).toBe(videoText('an'))
    rerender(panel({ lines: [] }))
    expect(tid('project-home-building-lines')).toBeNull()
  })

  it('names the macro agent when given one', () => {
    mount(<BuildingPanel kind="page" title="FAQ" agentName="docs-builder" jobStatus={job()} />)
    expect(tid('project-home-building-text')?.textContent).toBe(PAGE_TEXT.replace('project-home-builder', 'docs-builder'))
  })

  it('shows no Open session without an Epic or a handler', () => {
    mount(panel({ jobStatus: job({ epicId: null }), onOpenSession: vi.fn() }))
    expect(tid('project-home-building-session')).toBeNull()
    expect(tid('project-home-building-elapsed')?.textContent).toBe('Waiting to start')
    rerender(panel({ onOpenSession: undefined }))
    expect(tid('project-home-building-session')).toBeNull()
  })
})

describe('failureShown', () => {
  const failed = (finishedAt: string | null, startedAt: string | null = null) =>
    job({ state: 'failed', status: 'failed', reason: 'boom', finishedAt, startedAt })
  const launch = (at: number): BuildLaunch => ({ title: 't', lines: [], at })

  it('shows only a failed job', () => {
    expect(failureShown(undefined, undefined)).toBe(false)
    expect(failureShown(job({ state: 'running' }), undefined)).toBe(false)
    expect(failureShown(job({ state: 'done' }), undefined)).toBe(false)
    expect(failureShown(failed(isoAgo(1000)), undefined)).toBe(true)
  })

  it('hides a failure once a later launch from this window supersedes it, never the launch that failed', () => {
    const finished = Date.now() - 10_000
    const f = failed(new Date(finished).toISOString())
    expect(failureShown(f, launch(finished - 60_000))).toBe(true)
    expect(failureShown(f, launch(finished + 1))).toBe(false)
    // No finish time: fall back to the start time, else keep showing it.
    expect(failureShown(failed(null, new Date(finished).toISOString()), launch(finished + 1))).toBe(false)
    expect(failureShown(failed(null, null), launch(Date.now()))).toBe(true)
  })
})

function Settled({ cwd, jobs, onSettled }: { cwd: string | null; jobs: Record<string, MacroJobStatus>; onSettled: (s: MacroJobStatus) => void }) {
  useJobSettled(cwd, jobs, onSettled)
  return null
}

describe('useJobSettled', () => {
  const page = (state: MacroJobStatus['state'], slug = 'project-home-build-a') => ({
    'builtin-project-home': job({ macroId: 'builtin-project-home', slug, state }),
  })

  it('reports a job once when it goes from queued / running to done — never on first sight or for an unchanged snapshot', () => {
    const seen: string[] = []
    const on = (s: MacroJobStatus) => seen.push(`${s.macroId} ${s.slug} ${s.state}`)
    mount(<Settled cwd="/proj" jobs={page('done', 'project-home-build-old')} onSettled={on} />)
    rerender(<Settled cwd="/proj" jobs={page('queued')} onSettled={on} />)
    rerender(<Settled cwd="/proj" jobs={page('running')} onSettled={on} />)
    expect(seen).toEqual([])
    rerender(<Settled cwd="/proj" jobs={page('done')} onSettled={on} />)
    // A fresh snapshot object of the same finished job, and a re-render with a new callback.
    rerender(<Settled cwd="/proj" jobs={page('done')} onSettled={on} />)
    rerender(<Settled cwd="/proj" jobs={page('done')} onSettled={(s) => on(s)} />)
    expect(seen).toEqual(['builtin-project-home project-home-build-a done'])
  })

  it('reports a failure, and a job that finished straight from queued', () => {
    const seen: string[] = []
    const on = (s: MacroJobStatus) => seen.push(`${s.macroId} ${s.state}`)
    mount(<Settled cwd="/proj" jobs={{ ...page('running'), 'builtin-demo-video': job({ state: 'queued' }) }} onSettled={on} />)
    rerender(<Settled cwd="/proj" jobs={{ ...page('failed'), 'builtin-demo-video': job({ state: 'done' }) }} onSettled={on} />)
    expect(seen).toEqual(['builtin-project-home failed', 'builtin-demo-video done'])
  })

  it('never reports across a project switch or a different job', () => {
    const seen: string[] = []
    const on = (s: MacroJobStatus) => seen.push(s.state)
    mount(<Settled cwd="/a" jobs={page('running', 'same')} onSettled={on} />)
    rerender(<Settled cwd="/b" jobs={page('done', 'same')} onSettled={on} />)
    rerender(<Settled cwd="/b" jobs={page('running', 'b-1')} onSettled={on} />)
    rerender(<Settled cwd="/b" jobs={page('done', 'b-2')} onSettled={on} />)
    expect(seen).toEqual([])
  })
})
