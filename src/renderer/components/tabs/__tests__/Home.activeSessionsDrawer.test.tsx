// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ActiveSessionsCard } from '../Home'
import { useScheduleState } from '../../../state/scheduleState'
import { usePromptSessions } from '../../../state/promptSessions'
import { useChat } from '../../../state/chat'

/**
 * Wiring coverage for PRD 967: clicking an Active-sessions row opens the
 * real HomeSessionDrawer (not a stub) with real KeyVals sourced from
 * activeSessionRows()/store state, and — for a running chat run — a live
 * tail built from the Epic's real chat turns.
 */

function installWindowApiMock() {
  const api = {
    schedule: {
      sessionSlots: vi.fn().mockResolvedValue({
        total: 5,
        inUse: 1,
        holders: [{ owner: 'chat:epic-2', at: '2026-08-02T20:00:00.000Z' }],
        min: 0,
        max: 10,
        default: 5,
        envOverride: false,
      }),
    },
  }
  ;(window as unknown as { api: typeof api }).api = api
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(createElement(ActiveSessionsCard, {}))
    await Promise.resolve()
    await Promise.resolve()
  })
  return container
}

beforeEach(() => {
  installWindowApiMock()
  usePromptSessions.setState({
    sessions: {
      'epic-2': { id: 'epic-2', cwd: '/home/bilko/Projects/sigma', goalText: 'Signal scoring pass' } as never,
    },
  })
  useChat.setState({
    chats: {
      'epic-2': {
        turns: [{ id: 't1', role: 'assistant', text: 'Queued PRD 967 for review.', at: 0 }],
        running: true,
        queuedPosition: 0,
        started: true,
        stream: '',
        liveToolUses: [],
        queue: [],
      } as never,
    },
  })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  delete (window as unknown as { api?: unknown }).api
  useScheduleState.setState({ snapshot: null, loaded: false })
  usePromptSessions.setState({ sessions: {} })
  useChat.setState({ chats: {} })
})

describe('ActiveSessionsCard drawer wiring', () => {
  it('opens the real HomeSessionDrawer with KeyVals + live tail on row click', async () => {
    const el = await mount()
    const rowBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('chat:epic-2'))!
    await act(async () => {
      rowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const drawer = document.querySelector('[data-testid="home-drawer"]')!
    expect(drawer).not.toBeNull()
    expect(drawer.textContent).toContain('Signal scoring pass')
    expect(drawer.textContent).toContain('sigma')
    expect(drawer.textContent).toContain('chat run')
    expect(drawer.textContent).toContain('Live tail')
    expect(drawer.textContent).toContain('Queued PRD 967 for review.')
  })

  it('closes the drawer via the Close button', async () => {
    const el = await mount()
    const rowBtn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('chat:epic-2'))!
    await act(async () => {
      rowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    const closeBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close')!
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="home-drawer"]')).toBeNull()
  })
})
