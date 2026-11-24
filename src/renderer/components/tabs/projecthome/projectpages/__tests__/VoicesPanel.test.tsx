// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { VoicesPanel, laneStatusText } from '../VoicesPanel'
import { useToast } from '../../../../../state/toast'
import type { VoiceLibraryEntry, VoicesListResult } from '../../../../../../preload/api'

function voice(id: string, over: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    id,
    label: `Label ${id}`,
    voice: {},
    engine: 'kokoro',
    sampleText: `Sample for ${id}`,
    licence: 'Apache-2.0',
    heavy: false,
    scope: 'builtin',
    approved: false,
    pinOk: true,
    lastPreview: null,
    inLane: null,
    ...over,
  }
}

const list = vi.fn()
const preview = vi.fn()
const play = vi.fn()
const pause = vi.fn()
const createObjectURL = vi.fn()
const revokeObjectURL = vi.fn()
let audios: Array<{ src: string; onended: (() => void) | null }> = []

function listResult(voices: VoiceLibraryEntry[], lane: VoicesListResult['lane'] = {}): VoicesListResult {
  return { voices, errors: [], lane }
}

beforeEach(() => {
  list.mockReset().mockResolvedValue(
    listResult([
      voice('af_heart', { approved: true }),
      voice('mine', {
        scope: 'project',
        engine: 'piper',
        licence: 'CC-BY',
        lastPreview: { at: '2026-11-23T20:00:00.000Z', wallMs: 2500, audioSeconds: 3 },
      }),
    ]),
  )
  preview.mockReset().mockResolvedValue({ ok: true, cached: false, wavPath: '/x.wav', bytes: new Uint8Array([1, 2, 3]) })
  play.mockReset().mockResolvedValue(undefined)
  pause.mockReset()
  createObjectURL.mockReset().mockReturnValue('blob:voice-1')
  revokeObjectURL.mockReset()
  audios = []
  ;(window as unknown as { api: unknown }).api = { voices: { list, preview } }
  ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL
  ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL
  ;(window as unknown as { Audio: unknown }).Audio = class {
    src: string
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    play = play
    pause = pause
    constructor(src: string) {
      this.src = src
      audios.push(this)
    }
  }
  useToast.setState({ toasts: [], history: [], unreadCount: 0 })
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.useRealTimers()
})

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<VoicesPanel cwd="/proj" />))
  await flush()
}

const q = (sel: string) => container!.querySelector(sel)

describe('VoicesPanel', () => {
  it('lists one row per voice with label, engine, licence, scope and last preview', async () => {
    await mount()
    expect(list).toHaveBeenCalledWith({ cwd: '/proj' })
    expect(q('[data-testid="voices-panel"]')).not.toBeNull()
    const row = q('[data-testid="voice-row-mine"]')!
    expect(row.textContent).toContain('Label mine')
    expect(row.textContent).toContain('piper')
    expect(row.textContent).toContain('CC-BY')
    expect(row.textContent).toContain('project')
    expect(q('[data-testid="voice-last-preview-mine"]')!.textContent).toContain('2.5s')
    expect(q('[data-testid="voice-row-af_heart"]')!.textContent).toContain('Sample for af_heart')
    expect(q('[data-testid="voice-lane-status"]')!.textContent).toContain('idle')
  })

  it('shows the Approved badge only on approved voices', async () => {
    await mount()
    expect(q('[data-testid="voice-row-af_heart"] [data-testid="voice-approved"]')).not.toBeNull()
    expect(q('[data-testid="voice-row-mine"] [data-testid="voice-approved"]')).toBeNull()
  })

  it('plays typed text as an audio/wav blob and revokes it after playback', async () => {
    await mount()
    const input = q('[data-testid="voice-text-input"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Hello there')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(q('[data-testid="voice-play-mine"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(preview).toHaveBeenCalledWith({ cwd: '/proj', voiceId: 'mine', text: 'Hello there' })
    const blob = createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('audio/wav')
    expect(audios[0].src).toBe('blob:voice-1')
    expect(play).toHaveBeenCalled()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    act(() => audios[0].onended?.())
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:voice-1')
  })

  it('uses the sample text when nothing is typed and says cached on a cache hit', async () => {
    preview.mockResolvedValue({ ok: true, cached: true, wavPath: '/x.wav', bytes: new Uint8Array([1]) })
    await mount()
    await act(async () => {
      ;(q('[data-testid="voice-play-af_heart"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(preview).toHaveBeenCalledWith({ cwd: '/proj', voiceId: 'af_heart', text: 'Sample for af_heart' })
    expect(q('[data-testid="voice-cached-af_heart"]')!.textContent).toContain('cached')
  })

  it('a new Play stops the previous audio', async () => {
    createObjectURL.mockReturnValueOnce('blob:a').mockReturnValueOnce('blob:b')
    await mount()
    await act(async () => {
      ;(q('[data-testid="voice-play-af_heart"]') as HTMLButtonElement).click()
    })
    await flush()
    await act(async () => {
      ;(q('[data-testid="voice-play-mine"]') as HTMLButtonElement).click()
    })
    await flush()
    expect(pause).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:a')
  })

  it('sends a failed preview to the error toast', async () => {
    preview.mockResolvedValue({ ok: false, error: 'voice not approved' })
    await mount()
    await act(async () => {
      ;(q('[data-testid="voice-play-mine"]') as HTMLButtonElement).click()
    })
    await flush()
    const toasts = useToast.getState().toasts
    expect(toasts.some((t) => t.kind === 'error' && t.message.includes('voice not approved'))).toBe(true)
  })

  it('sends a failed list to the error toast', async () => {
    list.mockRejectedValue(new Error('boom'))
    await mount()
    const toasts = useToast.getState().toasts
    expect(toasts.some((t) => t.kind === 'error' && t.message.includes('boom'))).toBe(true)
  })

  it('refreshes the lane every 2 seconds while mounted and stops after unmount', async () => {
    vi.useFakeTimers()
    await mount()
    const calls = list.mock.calls.length
    list.mockResolvedValue(
      listResult([voice('af_heart')], {
        heavy: [
          { voiceId: 'af_heart', label: 'Heart', projectRoot: '/proj', pid: 1, since: '', position: 0 },
          { voiceId: 'mine', label: 'Mine', projectRoot: '/proj', pid: 2, since: '', position: 1 },
        ],
      }),
    )
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    await flush()
    expect(list.mock.calls.length).toBe(calls + 1)
    expect(q('[data-testid="voice-lane-status"]')!.textContent).toContain('Heart')
    expect(q('[data-testid="voice-lane-status"]')!.textContent).toContain('1 waiting')
    act(() => root?.unmount())
    root = null
    const after = list.mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(6000)
    })
    expect(list.mock.calls.length).toBe(after)
  })
})

describe('laneStatusText', () => {
  it('is idle with no tickets', () => {
    expect(laneStatusText({})).toBe('idle')
    expect(laneStatusText({ heavy: [], light: [] })).toBe('idle')
  })
})
