// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EpicQueue } from '../epics/EpicQueue'
import type { PromptSession, PromptSessionEvent } from '../../state/promptSessions'
import type { EpicSnapshots } from '../../lib/epicDerive'
import type { TabChat } from '../../state/chat'
import type { PrdListItem } from '../../../preload/api'

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

function mount(el: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(el))
  return container
}

const NOW = Date.parse('2026-07-31T12:00:00.000Z')

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
  return {
    sessions: {},
    chats: {},
    jobs: [],
    prds: [],
    ...overrides,
  }
}

describe('EpicQueue', () => {
  it('groups epics by status in order running/needs/queued/draft/completed, with completed collapsed by default', () => {
    const epics: PromptSession[] = [
      makeEpic({ id: 'e-completed', status: 'completed' }),
      makeEpic({ id: 'e-running' }),
      makeEpic({ id: 'e-needs' }),
      makeEpic({ id: 'e-queued' }),
      makeEpic({ id: 'e-draft' }),
    ]
    const chats: Record<string, TabChat> = {
      'e-needs': { turns: [], running: false, queuedPosition: 0, ticketHistory: [{ status: 'needs-input' }] } as unknown as TabChat,
      'e-running': { turns: [], running: true, queuedPosition: 0 } as unknown as TabChat,
      'e-queued': { turns: [], running: true, queuedPosition: 1 } as unknown as TabChat,
    }
    const snapshots = emptySnapshots({
      sessions: Object.fromEntries(epics.map((e) => [e.id, e])),
      chats,
    })
    const events: Record<string, PromptSessionEvent[]> = {}

    const el = mount(
      <EpicQueue
        epics={epics}
        snapshots={snapshots}
        events={events}
        selectedId={null}
        onSelect={() => {}}
        onNew={() => {}}
        now={NOW}
      />,
    )

    const labels = Array.from(el.querySelectorAll('[data-testid="epic-queue-row"]')).map((n) => n.getAttribute('data-epic-id'))
    // Completed section is collapsed by default, so only the 4 open-section rows render.
    expect(labels).toEqual(['e-running', 'e-needs', 'e-queued', 'e-draft'])

    const sectionLabels = el.textContent ?? ''
    expect(sectionLabels).toContain('completed')
    expect(sectionLabels).not.toContain('e-completed')
  })

  it('fires onSelect with the clicked row epic id', () => {
    const epics = [makeEpic({ id: 'e-a' }), makeEpic({ id: 'e-b' })]
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const onSelect = vi.fn()

    const el = mount(
      <EpicQueue epics={epics} snapshots={snapshots} events={{}} selectedId={null} onSelect={onSelect} onNew={() => {}} now={NOW} />,
    )

    const row = el.querySelector('[data-epic-id="e-b"]') as HTMLButtonElement
    act(() => row.click())
    expect(onSelect).toHaveBeenCalledWith('e-b')
  })

  it('renders compact single-line rows when compact is true, and fuller rows when false', () => {
    const epics = [makeEpic({ id: 'e-a' })]
    const snapshots = emptySnapshots({
      sessions: Object.fromEntries(epics.map((e) => [e.id, e])),
      prds: [{ slug: 'p1', title: 'PRD one', cwd: '/proj', mtimeMs: 0, estimateMinutes: null, parallelGroup: 0, sourcePromptId: 'e-a' } as PrdListItem],
    })

    const compactEl = mount(
      <EpicQueue epics={epics} snapshots={snapshots} events={{}} selectedId={null} onSelect={() => {}} onNew={() => {}} compact now={NOW} />,
    )
    expect(compactEl.querySelector('[data-epic-id="e-a"]')?.textContent).not.toContain('PRD')

    act(() => root?.unmount())
    container?.remove()
    container = null
    root = null

    const comfortableEl = mount(
      <EpicQueue epics={epics} snapshots={snapshots} events={{}} selectedId={null} onSelect={() => {}} onNew={() => {}} now={NOW} />,
    )
    expect(comfortableEl.querySelector('[data-epic-id="e-a"]')?.textContent).toContain('PRD')
  })

  it('renders an empty state with a New Epic affordance when there are zero epics', () => {
    const el = mount(
      <EpicQueue epics={[]} snapshots={emptySnapshots()} events={{}} selectedId={null} onSelect={() => {}} onNew={() => {}} now={NOW} />,
    )
    expect(el.textContent).toContain('No sessions yet')
    expect(el.querySelectorAll('[data-testid="epic-queue-row"]')).toHaveLength(0)
  })

  it('renders 200 generated epics without hanging', () => {
    const epics: PromptSession[] = Array.from({ length: 200 }, (_, i) =>
      makeEpic({ id: `epic-${i}`, status: i % 7 === 0 ? 'completed' : 'active' }),
    )
    const snapshots = emptySnapshots({ sessions: Object.fromEntries(epics.map((e) => [e.id, e])) })
    const el = mount(
      <EpicQueue epics={epics} snapshots={snapshots} events={{}} selectedId={null} onSelect={() => {}} onNew={() => {}} now={NOW} />,
    )
    expect(el.querySelector('[data-testid="epic-queue-row"]')).not.toBeNull()
  })
})
