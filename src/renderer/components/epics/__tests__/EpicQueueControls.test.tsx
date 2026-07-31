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

    const input = el.querySelector('input[aria-label="Search Epics"]') as HTMLInputElement
    act(() => setInputValue(input, 'zzz-nomatch'))
    expect(el.textContent).toContain('No Epics match')
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

  it('suppresses j/k when focus is inside a text input', () => {
    const epics = [makeEpic({ id: 'e-a' }), makeEpic({ id: 'e-b' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const onSelect = vi.fn()
    const el = mount(<EpicQueueControls {...baseProps(epics, snapshots, { selectedId: 'e-a', onSelect })} />)

    const input = el.querySelector('input[aria-label="Search Epics"]') as HTMLInputElement
    input.focus()
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true })))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
