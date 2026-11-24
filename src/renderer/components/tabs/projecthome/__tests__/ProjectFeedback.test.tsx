// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ProjectFeedback } from '../ProjectFeedback'
import { ProjectHomeKeyButtons, type KeyLibraryStats } from '../projectpages/ProjectHomeKeyButtons'
import { useSiteFeedback } from '../../../../state/siteFeedback'
import type { SiteFeedbackInboxItem } from '../../../../../preload/api'

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
  useSiteFeedback.setState({ byCwd: {} })
})

const item = (hostId: string, status: SiteFeedbackInboxItem['status']): SiteFeedbackInboxItem => ({
  hostId,
  boxId: 'b1',
  receivedAt: '2026-11-23T00:00:00Z',
  origin: 'https://example.com',
  status,
  statusNote: null,
  epicId: null,
  statusChangedAt: '2026-11-23T00:00:00Z',
  title: `Item ${hostId}`,
  type: 'bug',
  reporter: null,
})

const NONE: KeyLibraryStats = { count: 0, building: 0, latestMs: null }
const feedbackKey = (el: HTMLElement) =>
  el.querySelector('[data-testid="project-home-key"][data-tab="feedback"]') as HTMLButtonElement | null
const badge = (btn: HTMLElement) => btn.querySelector('[data-testid="project-home-key-count"]')

describe('Project Home Feedback key button', () => {
  it('is the fourth key, labelled Feedback, with no badge at 0 open items', () => {
    const el = mount(
      <ProjectHomeKeyButtons tab="pages" onTabChange={() => {}} pages={NONE} videos={NONE} findingsCount={null} feedbackOpenCount={0} />,
    )
    const tabs = Array.from(el.querySelectorAll('[data-testid="project-home-key"]')).map((b) => b.getAttribute('data-tab'))
    expect(tabs).toEqual(['pages', 'videos', 'tools', 'feedback'])
    const key = feedbackKey(el)!
    expect(key.querySelector('[data-testid="project-home-key-label"]')?.textContent).toBe('Feedback')
    expect(badge(key)).toBeNull()
  })

  it('shows the open-item count when above 0 and switches to the feedback tab', () => {
    const onTabChange = vi.fn()
    const el = mount(
      <ProjectHomeKeyButtons tab="feedback" onTabChange={onTabChange} pages={NONE} videos={NONE} findingsCount={null} feedbackOpenCount={3} />,
    )
    const key = feedbackKey(el)!
    expect(badge(key)?.textContent).toBe('3')
    expect(key.getAttribute('aria-pressed')).toBe('true')
    act(() => key.click())
    expect(onTabChange).toHaveBeenCalledWith('feedback')
  })
})

describe('ProjectFeedback', () => {
  let widgetList: ReturnType<typeof vi.fn>
  let inboxList: ReturnType<typeof vi.fn>

  beforeEach(() => {
    widgetList = vi.fn(async () => ({ ok: true, widgets: [] }))
    inboxList = vi.fn(async () => ({ ok: true, items: [item('h1', 'open'), item('h2', 'resolved')] }))
    ;(window as unknown as { api: unknown }).api = { siteFeedback: { widgetList, inboxList } }
  })

  it('renders the Website widget and Inbox headings and loads widgets and items for its cwd on mount', async () => {
    const el = mount(<ProjectFeedback cwd="/proj" />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    const headings = Array.from(el.querySelectorAll('h2')).map((h) => h.textContent)
    expect(headings).toEqual(['Website widget', 'Inbox'])
    expect(widgetList).toHaveBeenCalledWith({ cwd: '/proj' })
    expect(inboxList).toHaveBeenCalledWith({ cwd: '/proj' })
    expect(useSiteFeedback.getState().byCwd['/proj']?.items).toHaveLength(2)
  })
})
