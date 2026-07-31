// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { TerminalChat } from '../TerminalChat'
import { useSessions } from '../../state/sessions'
import { useVoice } from '../../state/voice'
import { useScheduleState } from '../../state/scheduleState'

// jsdom has no AudioWorkletNode/mediaDevices.getUserMedia, so the real
// isRecognitionSupported() always reports "unsupported" (mic button
// natively disabled, clicks inert) — stub it so the click-handling test can
// exercise the "ready" gate path instead.
vi.mock('../../lib/speechRecognition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/speechRecognition')>()
  return { ...actual, isRecognitionSupported: () => true }
})

// TerminalChat's mount-time hydrate() no-ops without window.api.exchanges
// (see state/chat.ts), so no window.api mock is needed for a plain render.

function mount(tabId: string) {
  // TerminalChat reads `s.snapshot?.jobs ?? []` from useScheduleState; with
  // snapshot left null that `?? []` allocates a fresh array on every
  // getSnapshot call, which useSyncExternalStore treats as a changed
  // snapshot and re-renders forever. Give it a stable snapshot so the
  // selector returns the same array reference across renders.
  useScheduleState.setState({ snapshot: { jobs: [] } as any, loaded: true })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(TerminalChat, { tabId, cwd: '/tmp/project' }))
  })
  return { container, root }
}

describe('TerminalChat composer — VoiceButton placement (PRD 791)', () => {
  afterEach(() => {
    useSessions.setState({ tabs: [], activeTabId: null })
    useVoice.setState({ modelStatus: 'idle', permissionState: 'unknown', isRecording: false })
  })

  it('renders the mic button as the composer row\'s first child, left of the textarea', () => {
    const { container, root } = mount('tab-1')
    try {
      const row = container.querySelector('textarea')?.parentElement
      expect(row).not.toBeNull()
      const mic = row?.querySelector('[data-testid="mic-button"]')
      expect(mic).not.toBeNull()
      // First element child of the composer row is the mic button, not the textarea.
      expect(row?.firstElementChild).toBe(mic)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('clicking the composer mic button starts recording against the active tab', () => {
    useSessions.setState({
      tabs: [{ id: 'tab-active', sessionId: 'tab-active', label: 'test', cwd: '/tmp/project' } as any],
      activeTabId: 'tab-active',
    })
    useVoice.setState({ modelStatus: 'ready', permissionState: 'granted' as any, isRecording: false })
    const startRecording = vi.fn()
    useVoice.setState({ startRecording })

    const { container, root } = mount('tab-active')
    try {
      const mic = container.querySelector('[data-testid="mic-button"]') as HTMLButtonElement
      expect(mic).not.toBeNull()
      act(() => {
        mic.click()
      })
      expect(startRecording).toHaveBeenCalledWith('tab-active')
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
