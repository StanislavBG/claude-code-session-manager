/**
 * Web Worker that runs speech-to-text via Transformers.js (ONNX).
 *
 * Model: Moonshine Base — purpose-built for short utterances. Unlike Whisper,
 * which zero-pads every input to 30s before encoding (the source of our old
 * ~1-2s latency floor on short commands), Moonshine's encoder cost scales with
 * actual audio length, so a 2s utterance encodes in ~150ms.
 *
 * F6 — Streaming partials: this worker also handles `transcribe-partial`
 * messages that run the same Moonshine call on a tail-window slice and post
 * back `{type: 'partial', text, seq}`. The host distinguishes partial vs
 * final responses by the `type` field. Partials and finals share the same
 * single-threaded wasm pipeline — they queue, they don't run concurrently.
 *
 * NOTE: `onnx-community/moonshine-base-ONNX` is **English-only**. Partials
 * (and finals) on non-English audio will be hallucinated English. F6 is
 * scoped English-only until the model is swapped.
 */

import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { collapseRepetition } from './transcriptSanitize'

let transcriber: AutomaticSpeechRecognitionPipeline | null = null

const MODEL_ID = 'onnx-community/moonshine-base-ONNX'

// Generation guard against decoder repetition loops. Moonshine (like Whisper)
// can get stuck repeating a phrase on silence / low-quality / overlong audio,
// emitting it dozens of times verbatim. `no_repeat_ngram_size: 3` forbids any
// 3-gram from repeating (kills verbatim phrase loops at the source);
// `repetition_penalty` discourages token-level loops. Backstopped by
// collapseRepetition() on the output. Passed as generation kwargs to the ASR
// pipeline (typed loosely by the lib, hence the cast).
const GEN_OPTS = { no_repeat_ngram_size: 3, repetition_penalty: 1.15 } as Record<string, unknown>

function workerLog(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  self.postMessage({ type: 'log', level, message, meta })
}

async function loadModel() {
  if (transcriber) return
  workerLog('info', 'load: begin', { model: MODEL_ID })
  self.postMessage({ type: 'status', status: 'loading', message: 'Downloading speech model…' })

  // Detect "loaded entirely from cache": transformers.js fires no progress
  // events when nothing needs downloading, so the UI's progress bar would
  // sit at 0% the whole time and look stuck. If pipeline() doesn't report
  // any download progress within 1.5s, switch the status text.
  let progressSeen = false
  let phase: 'downloading' | 'cache-loading' = 'downloading'
  const cacheHintTimer = setTimeout(() => {
    if (!progressSeen && !transcriber) {
      phase = 'cache-loading'
      self.postMessage({ type: 'status', status: 'loading', message: 'Loading speech model from cache…' })
      workerLog('info', 'load: no download progress within 1.5s, assuming cache hit')
    }
  }, 1500)

  // Heartbeat: cache-loaded pipeline() init is silent (no progress events).
  // On slow machines pipeline + warmup can run 30-90s with no messages, which
  // trips the host's 90s no-progress watchdog and surfaces "Model load timed
  // out" even though loading is fine. Emit a status ping every 10s so the
  // host re-arms its watchdog. Cleared in the finally below.
  const heartbeatTimer = setInterval(() => {
    if (transcriber) return
    const message = phase === 'downloading' ? 'Downloading speech model…' : 'Loading speech model from cache…'
    self.postMessage({ type: 'status', status: 'loading', message })
  }, 10000)

  try {
    const pipelineStart = Date.now()
    transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
      dtype: 'fp32',
      device: 'wasm',
      // Aggregate download progress across all model files. v4 gives us a
      // single 0-100 'progress_total' event in addition to per-file events.
      progress_callback: (e: { status: string; progress?: number; file?: string }) => {
        if (e.status === 'progress_total' && typeof e.progress === 'number') {
          progressSeen = true
          self.postMessage({ type: 'progress', pct: e.progress })
        } else if (e.status === 'download' || e.status === 'initiate') {
          progressSeen = true
          workerLog('debug', 'pipeline: ' + e.status, { file: e.file })
        }
      },
    })
    workerLog('info', 'load: pipeline ready', { ms: Date.now() - pipelineStart })

    // Warmup: force encoder/decoder JIT before the first real utterance so the
    // user doesn't pay an extra ~500ms on their first command. Race against a
    // 10s timeout so a hung warmup can't deadlock the entire load.
    const warmupStart = Date.now()
    try {
      await Promise.race([
        transcriber(new Float32Array(16000)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('warmup timeout')), 10000)),
      ])
      workerLog('info', 'load: warmup done', { ms: Date.now() - warmupStart })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      workerLog('warn', 'load: warmup failed (best-effort, ignored)', { error: msg, ms: Date.now() - warmupStart })
    }

    self.postMessage({ type: 'status', status: 'ready', message: 'Speech model ready' })
  } finally {
    clearTimeout(cacheHintTimer)
    clearInterval(heartbeatTimer)
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data

  if (type === 'load') {
    try {
      await loadModel()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Model load failed'
      const stack = err instanceof Error ? err.stack : ''
      console.error('[speechWorker] load failed:', msg, stack)
      workerLog('error', 'load: failed', { error: msg, stack })
      self.postMessage({ type: 'error', error: msg })
    }
    return
  }

  if (type === 'transcribe') {
    const audio: Float32Array = e.data.audio
    // F6 P0-3: echo seq on result so the host's stale-partial check has the
    // authoritative final-seq from the worker instead of an optimistic
    // submission-time guess. Falls back to 0 if the host didn't tag.
    const seq: number = e.data.seq ?? 0
    if (!transcriber) {
      workerLog('warn', 'transcribe: model not loaded, dropping segment', { samples: audio?.length, seq })
      self.postMessage({ type: 'error', error: 'Model not loaded', seq })
      return
    }
    const start = Date.now()
    try {
      const result = await transcriber(audio, GEN_OPTS)
      const text = collapseRepetition((result as { text?: string }).text?.trim() ?? '')
      workerLog('debug', 'transcribe: ok', { ms: Date.now() - start, samples: audio.length, chars: text.length, seq })
      self.postMessage({ type: 'result', text, seq })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Transcription failed'
      workerLog('error', 'transcribe: failed', { error: msg, ms: Date.now() - start, seq })
      self.postMessage({ type: 'error', error: msg, seq })
    }
    return
  }

  // F6: partial encode on a tail-window slice. Same Moonshine call, different
  // response tag so the host can distinguish provisional from authoritative.
  // We deliberately do NOT swallow errors as `error` (which the host treats
  // as fatal for the recording) — partials post `partial-error` so the host
  // can drop and keep recording. seq is echoed for cancel-by-suppress.
  if (type === 'transcribe-partial') {
    const audio: Float32Array = e.data.audio
    const seq: number = e.data.seq ?? 0
    if (!transcriber) {
      workerLog('warn', 'transcribe-partial: model not loaded, dropping', { samples: audio?.length, seq })
      self.postMessage({ type: 'partial-error', seq, error: 'Model not loaded' })
      return
    }
    const start = Date.now()
    try {
      const result = await transcriber(audio, GEN_OPTS)
      const text = collapseRepetition((result as { text?: string }).text?.trim() ?? '')
      // Per F6 PRD §Security & Privacy: never log partial content. `audio.length`
      // leaks cadence — accepted residual risk.
      // TODO(F6-followup): cadence-leak telemetry hardening.
      workerLog('debug', 'transcribe-partial: ok', { ms: Date.now() - start, samples: audio.length, chars: text.length, seq })
      self.postMessage({ type: 'partial', text, seq })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Partial transcription failed'
      workerLog('warn', 'transcribe-partial: failed', { error: msg, ms: Date.now() - start, seq })
      self.postMessage({ type: 'partial-error', seq, error: msg })
    }
    return
  }
}
