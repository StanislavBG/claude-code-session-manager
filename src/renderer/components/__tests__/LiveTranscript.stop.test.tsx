// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { LiveTranscript } from '../LiveTranscript'
import { useVoice } from '../../state/voice'

let container: HTMLDivElement | null = null
let root: Root | null = null
let initial: ReturnType<typeof useVoice.getState>

function stopBtn(): HTMLButtonElement | null {
  return document.querySelector('[data-testid="live-transcript-stop"]')
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<LiveTranscript />)
  })
}

beforeEach(() => {
  initial = useVoice.getState()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  useVoice.setState(initial, true)
})

describe('LiveTranscript stop button', () => {
  it('is present while recording', async () => {
    useVoice.setState({ isRecording: true, statusPill: 'idle', lastPartial: '', lastTranscript: '' })
    await mount()
    const btn = stopBtn()
    expect(btn).not.toBeNull()
    expect(btn!.getAttribute('aria-label')).toBe('Stop microphone')
    expect(btn!.className).toContain('pointer-events-auto')
  })

  it('is absent when not recording but a partial is fading out', async () => {
    useVoice.setState({ isRecording: false, statusPill: 'idle', lastPartial: 'hello', lastTranscript: '' })
    await mount()
    expect(document.querySelector('[data-testid="live-transcript"]')).not.toBeNull()
    expect(stopBtn()).toBeNull()
  })

  it('click calls stopRecording once', async () => {
    const stopRecording = vi.fn()
    useVoice.setState({ isRecording: true, statusPill: 'idle', lastPartial: '', lastTranscript: '', stopRecording })
    await mount()
    await act(async () => {
      stopBtn()!.click()
    })
    expect(stopRecording).toHaveBeenCalledTimes(1)
  })
})
