// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { RecordingStatus } from '../RecordingStatus'
import { useVoice } from '../../state/voice'

let container: HTMLDivElement | null = null
let root: Root | null = null

function q(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`)
}

async function mount(state: { isRecording: boolean; externalRecording: boolean }, stop = vi.fn()) {
  useVoice.setState({ ...state, stopRecording: stop } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RecordingStatus />)
  })
  return stop
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  root = null
  container = null
  useVoice.setState({ isRecording: false, externalRecording: false })
})

describe('RecordingStatus stop button', () => {
  it('shows the stop button when store-owned recording is active', async () => {
    await mount({ isRecording: true, externalRecording: false })
    const btn = q('recording-status-stop')
    expect(btn).not.toBeNull()
    expect(btn!.getAttribute('aria-label')).toBe('Stop microphone')
    expect(btn!.textContent).toContain('Stop')
  })

  it('hides the stop button but keeps the banner for external-only recording', async () => {
    await mount({ isRecording: false, externalRecording: true })
    expect(q('recording-status')).not.toBeNull()
    expect(q('recording-status-stop')).toBeNull()
  })

  it('calls stopRecording once on click', async () => {
    const stop = await mount({ isRecording: true, externalRecording: false })
    await act(async () => {
      q('recording-status-stop')!.click()
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
