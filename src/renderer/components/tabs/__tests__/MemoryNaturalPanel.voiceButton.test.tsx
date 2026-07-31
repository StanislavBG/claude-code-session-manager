// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, afterEach, vi } from 'vitest'
import { MemoryNaturalPanel } from '../MemoryNaturalPanel'
import { useSessions } from '../../../state/sessions'
import { useVoice } from '../../../state/voice'

// jsdom has no AudioWorkletNode/mediaDevices.getUserMedia, so the real
// isRecognitionSupported() always reports "unsupported" — stub it so the
// click-handling test can exercise the "ready" gate path instead.
vi.mock('../../../lib/speechRecognition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/speechRecognition')>()
  return { ...actual, isRecognitionSupported: () => true }
})

// useHomeDir resolves async via window.api.app.homeDir(); stub it to a
// constant so the panel renders its composer synchronously in the test.
vi.mock('../../../lib/useHomeDir', () => ({
  useHomeDir: () => '/home/test',
}))

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      createElement(MemoryNaturalPanel, {
        workspace: 'test-workspace',
        entries: [],
        onChanged: () => {},
      }),
    )
  })
  return { container, root }
}

describe('MemoryNaturalPanel composer — VoiceButton (PRD 792)', () => {
  afterEach(() => {
    useSessions.setState({ tabs: [], activeTabId: null })
    useVoice.setState({ modelStatus: 'idle', permissionState: 'unknown', isRecording: false })
  })

  it('renders the mic button as the composer row\'s first child, left of the textarea', () => {
    const { container, root } = mount()
    try {
      const row = container.querySelector('textarea')?.parentElement
      expect(row).not.toBeNull()
      const mic = row?.querySelector('[data-testid="mic-button"]')
      expect(mic).not.toBeNull()
      expect(row?.firstElementChild).toBe(mic)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('clicking the composer mic button starts recording against the panel\'s active tab', () => {
    useSessions.setState({
      tabs: [{ id: 'tab-active', sessionId: 'tab-active', label: 'test', cwd: '/tmp/project' } as any],
      activeTabId: 'tab-active',
    })
    useVoice.setState({ modelStatus: 'ready', permissionState: 'granted' as any, isRecording: false })
    const startRecording = vi.fn()
    useVoice.setState({ startRecording })

    const { container, root } = mount()
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
