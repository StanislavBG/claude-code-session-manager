import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Lazy speech-model lifecycle: no load on mount, load on first record press,
 * worker released after 30 minutes without a recording.
 */

const preloadModel = vi.fn()
const releaseModel = vi.fn()
const createRecognition = vi.fn(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  destroy: vi.fn(),
  setVadThresholds: vi.fn(),
  getAnalyser: vi.fn(() => null),
}))

vi.mock('../../lib/speechRecognition', () => ({
  createRecognition: (...a: unknown[]) => (createRecognition as any)(...a),
  isRecognitionSupported: vi.fn(() => true),
  preloadModel: (...a: unknown[]) => preloadModel(...a),
  resetModel: vi.fn(),
  releaseModel: () => releaseModel(),
}))
vi.mock('../../lib/vadDucking', () => ({ attachVadDucking: vi.fn(() => () => {}) }))
vi.mock('../../lib/speechSynthesis', () => ({
  stopSpeaking: vi.fn(),
  isSpeaking: vi.fn(() => false),
  getSpeakStartedAt: vi.fn(() => null),
}))

async function loadStore() {
  vi.resetModules()
  const mod = await import('../voice')
  return mod
}

describe('voice lazy model', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    preloadModel.mockReset()
    releaseModel.mockReset()
    createRecognition.mockClear()
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('performance', { now: () => Date.now() })
    vi.stubGlobal('window', {
      api: { voice: { getDevicePref: vi.fn().mockResolvedValue(null) }, logs: { write: vi.fn() } },
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('no model load on mount', async () => {
    const { useVoice } = await loadStore()
    expect(preloadModel).not.toHaveBeenCalled()
    expect(useVoice.getState().modelStatus).toBe('idle')
  })

  it('first record press loads model', async () => {
    const { useVoice } = await loadStore()
    useVoice.getState().startRecording('t1')
    expect(preloadModel).toHaveBeenCalledTimes(1)
    expect(useVoice.getState().modelStatus).toBe('loading')
    expect(useVoice.getState().isRecording).toBe(false)
    expect(createRecognition).not.toHaveBeenCalled()

    // Model finishes loading -> recording begins.
    const onStatus = preloadModel.mock.calls[0][0]
    onStatus('ready', '')
    await vi.advanceTimersByTimeAsync(0)
    expect(createRecognition).toHaveBeenCalledTimes(1)
    expect(useVoice.getState().isRecording).toBe(true)
  })

  it('idle timeout releases worker', async () => {
    const { useVoice, MODEL_IDLE_RELEASE_MS } = await loadStore()
    useVoice.getState().startRecording('t1')
    preloadModel.mock.calls[0][0]('ready', '')
    await vi.advanceTimersByTimeAsync(0)
    useVoice.getState().stopRecording()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(MODEL_IDLE_RELEASE_MS - 1000)
    expect(releaseModel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(releaseModel).toHaveBeenCalledTimes(1)
    expect(useVoice.getState().modelStatus).toBe('idle')

    // Next press reloads.
    useVoice.getState().startRecording('t1')
    expect(preloadModel).toHaveBeenCalledTimes(2)
  })
})
