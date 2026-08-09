// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicQueueControls } from '../EpicQueueControls'
import { useEpicsPrefs } from '../../../state/epicsPrefs'
import type { PromptSession, PromptSessionEvent } from '../../../state/promptSessions'
import type { EpicSnapshots } from '../../../lib/epicDerive'
import type { TabChat } from '../../../state/chat'

let container: HTMLDivElement | null = null
let root: Root | null = null

const NOW = Date.parse('2026-07-31T12:00:00.000Z')

function installWindowApiMock() {
  ;(window as unknown as { api: unknown }).api = {
    config: {
      readJson: vi.fn().mockResolvedValue({ exists: false, data: null }),
      writeJson: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
}

beforeEach(() => {
  installWindowApiMock()
  useEpicsPrefs.setState({ pins: {}, group: 'status', sort: 'recent', compact: false, hydrated: true })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!

function setInputValue(input: HTMLInputElement, value: string) {
  nativeInputValueSetter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

function makeEpic(overrides: Partial<PromptSession>): PromptSession {
  return {
    id: overrides.id ?? 'epic-1',
    cwd: '/proj',
    goalText: 'A test epic',
    claudeSessionId: 'claude-1',
    status: 'active',
    createdAt: new Date(NOW - 60_000).toISOString(),
    completedAt: null,
    tag: 'feature',
    ...overrides,
  }
}

function emptySnapshots(overrides: Partial<EpicSnapshots> = {}): EpicSnapshots {
  return { sessions: {}, chats: {}, jobs: [], prds: [], ...overrides }
}

function baseProps(epics: PromptSession[], snapshots: EpicSnapshots, extra: Partial<React.ComponentProps<typeof EpicQueueControls>> = {}) {
  return {
    epics,
    snapshots,
    events: {} as Record<string, PromptSessionEvent[]>,
    selectedId: null,
    onSelect: vi.fn(),
    onNew: vi.fn(),
    now: NOW,
    ...extra,
  }
}

/** The filter strip is minimized by default (Actions own the header space) —
 *  the search box is behind its own toggle. */
function openSearch(el: HTMLElement): HTMLInputElement {
  const toggle = el.querySelector('[data-testid="epic-queue-search-toggle"]') as HTMLButtonElement
  act(() => toggle.click())
  return el.querySelector('input[aria-label="Search sessions"]') as HTMLInputElement
}

describe('EpicQueueControls', () => {
  it('renders chip counts derived from the full epic list', () => {
    const epics = [
      makeEpic({ id: 'e-completed', status: 'completed' }),
      makeEpic({ id: 'e-running' }),
      makeEpic({ id: 'e-needs' }),
    ]
    const chats: Record<string, TabChat> = {
      'e-needs': { turns: [], running: false, queuedPosition: 0, ticketHistory: [{ status: 'needs-input' }] } as unknown as TabChat,
      'e-running': { turns: [], running: true, queuedPosition: 0 } as unknown as TabChat,
    }
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])), chats })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    expect(el.textContent).toContain('Open 2')
    expect(el.textContent).toContain('Needs you 1')
    expect(el.textContent).toContain('Running 1')
    expect(el.textContent).toContain('Pinned 0')
    expect(el.textContent).toContain('All 3')
  })

  it('shows a "No Epics match" empty state on a search miss, and Clear filters restores the list', () => {
    const epics = [makeEpic({ id: 'e-a', goalText: 'alpha epic' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    const input = openSearch(el)
    act(() => setInputValue(input, 'zzz-nomatch'))
    expect(el.textContent).toContain('No sessions match')
    expect(el.querySelectorAll('[data-testid="epic-queue-row"]')).toHaveLength(0)

    const clearBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Clear filters') as HTMLButtonElement
    act(() => clearBtn.click())
    expect(el.querySelector('[data-epic-id="e-a"]')).not.toBeNull()
  })

  it('pages a section: shows first PAGE rows, then reveals the remainder on "Show more"', () => {
    const epics = Array.from({ length: 25 }, (_, i) => makeEpic({ id: `e-${i}`, status: 'active' }))
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    expect(el.querySelectorAll('[data-testid="epic-queue-row"]')).toHaveLength(18)
    expect(el.textContent).toContain('Show 7 more · 7 hidden')

    const showMore = el.querySelector('[data-testid="epic-queue-show-more"]') as HTMLButtonElement
    act(() => showMore.click())
    expect(el.querySelectorAll('[data-testid="epic-queue-row"]')).toHaveLength(25)
  })

  it('pins a row to a sticky top section and persists via the epicsPrefs store', () => {
    const epics = [makeEpic({ id: 'e-a' }), makeEpic({ id: 'e-b' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    const findPinBtn = () => el.querySelector('[data-epic-id="e-b"] ~ [data-testid="epic-queue-row-pin"]') as HTMLButtonElement
    expect(findPinBtn()).not.toBeNull()
    act(() => findPinBtn().click())

    expect(useEpicsPrefs.getState().pins['e-b']).toBe(true)
    expect(el.textContent).toContain('pinned')
    const write = (window as unknown as { api: { config: { writeJson: ReturnType<typeof vi.fn> } } }).api.config.writeJson
    expect(write).toHaveBeenCalled()

    // Unpinning returns the row to its regular section (no longer duplicated).
    // Re-query: pinning moved the row into a new sticky section, so the DOM
    // node backing the earlier reference is no longer attached.
    act(() => findPinBtn().click())
    expect(useEpicsPrefs.getState().pins['e-b']).toBe(false)
  })

  it('pin button is also reachable in compact mode', () => {
    useEpicsPrefs.setState({ compact: true })
    const epics = [makeEpic({ id: 'e-a' }), makeEpic({ id: 'e-b' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    const pinBtn = el.querySelector('[data-epic-id="e-b"] ~ [data-testid="epic-queue-row-pin"]') as HTMLButtonElement
    expect(pinBtn).not.toBeNull()
    act(() => pinBtn.click())
    expect(useEpicsPrefs.getState().pins['e-b']).toBe(true)
  })

  it('j/k keyboard nav follows pinned-first order and skips collapsed sections', () => {
    const epics = [
      makeEpic({ id: 'e-completed', status: 'completed' }),
      makeEpic({ id: 'e-second' }),
      makeEpic({ id: 'e-third' }),
    ]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    useEpicsPrefs.setState({ pins: { 'e-completed': true } })
    const onSelect = vi.fn()
    mount(<EpicQueueControls {...baseProps(epics, snapshots, { selectedId: 'e-completed', onSelect })} />)

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })))
    // Pinning excludes "e-completed" from the (now-empty, so absent) completed
    // section — it floats pinned-first — so "j" moves to the next visible
    // row, the first item of the one remaining open, non-collapsed section.
    expect(onSelect).toHaveBeenCalledWith('e-second')
  })

  it('renders exactly one 352px container holding TWO sections: Hot keys, then the sessions widget', () => {
    const epics = [makeEpic({ id: 'e-a' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    const containers = Array.from(el.querySelectorAll('*')).filter((node) => node.className?.toString().includes('w-[352px]'))
    expect(containers).toHaveLength(1)

    const hotkeys = el.querySelector('[data-testid="epic-queue-hotkeys"]')
    const widget = el.querySelector('[data-testid="epic-queue-widget"]')
    expect(hotkeys).not.toBeNull()
    expect(widget).not.toBeNull()
    // Hot keys first, the widget after it — the pane's only two sections.
    expect(hotkeys!.compareDocumentPosition(widget!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(hotkeys!.textContent).toContain('Hot keys')
    // Both Actions live in the Hot keys section, not loose in the pane.
    expect(hotkeys!.querySelector('[data-testid="session-actions-bar"]')).not.toBeNull()
  })

  it('makes the filter strip the widget\'s head bar — inside it, above the tiles', () => {
    const epics = [makeEpic({ id: 'e-a' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    const widget = el.querySelector('[data-testid="epic-queue-widget"]') as HTMLElement
    const filters = el.querySelector('[data-testid="epic-queue-filters"]') as HTMLElement
    // The head bar belongs to the widget, not to the pane header above it.
    expect(widget.contains(filters)).toBe(true)
    expect((el.querySelector('[data-testid="epic-queue-hotkeys"]') as HTMLElement).contains(filters)).toBe(false)
    // ...and it precedes the tiles it governs.
    const firstRow = el.querySelector('[data-testid="epic-queue-row"]') as HTMLElement
    expect(filters.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The pane's title + count moved onto that head bar.
    expect(filters.textContent).toContain('Sessions')
  })

  it('collapses the five status pills into ONE dropdown defaulting to Open, peer to group and sort', () => {
    const epics = [makeEpic({ id: 'e-a' }), makeEpic({ id: 'e-done', status: 'completed' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    const filters = el.querySelector('[data-testid="epic-queue-filters"]') as HTMLElement
    const selects = Array.from(filters.querySelectorAll('select')) as HTMLSelectElement[]
    // Three peer dropdowns — show / group / sort — and no pill row.
    expect(selects).toHaveLength(3)
    expect(filters.textContent).toContain('show')
    expect(filters.textContent).toContain('group')
    expect(filters.textContent).toContain('sort')

    const status = selects[0]
    expect(status.value).toBe('open')
    // Every status is still reachable, and still counted.
    expect(Array.from(status.options).map((o) => o.value)).toEqual(['open', 'needs', 'running', 'pinned', 'all'])
    expect(Array.from(status.options).map((o) => o.textContent)).toContain('All 2')

    // Switching it actually filters: under Open the completed session has no
    // section at all; under All its (collapsed-by-default) section appears.
    const completedSection = () => el.querySelector('[data-section-key="completed"]')
    expect(completedSection()).toBeNull()
    act(() => {
      status.value = 'all'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(completedSection()).not.toBeNull()
  })

  it('keeps row density reachable without a second options menu', () => {
    const epics = [makeEpic({ id: 'e-a' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots)} />)

    expect(el.querySelector('[data-testid="epic-queue-options-toggle"]')).toBeNull()
    const density = el.querySelector('[data-testid="epic-queue-density-toggle"]') as HTMLButtonElement
    act(() => density.click())
    expect(useEpicsPrefs.getState().compact).toBe(true)
  })

  it('suppresses j/k when focus is inside a text input', () => {
    const epics = [makeEpic({ id: 'e-a' }), makeEpic({ id: 'e-b' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const onSelect = vi.fn()
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots, { selectedId: 'e-a', onSelect })} />)

    const input = openSearch(el)
    input.focus()
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
