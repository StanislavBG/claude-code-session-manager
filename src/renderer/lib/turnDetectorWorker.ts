/**
 * F8 — Semantic turn-detector worker (SKELETON).
 *
 * MVP framing (PRD F8 v2):
 *   smart-turn-v3 is NOT a transformers.js pipeline task. The full
 *   integration requires direct `onnxruntime-web` glue, a custom mel-
 *   spectrogram extractor that matches `preprocessor_config.json`, model
 *   download/cache, and a sigmoid post-processor (~250 LOC). That work is
 *   deferred — see TODO(F8-followup) markers below.
 *
 * THIS FILE IS A STUB. It exists so the renderer-side loading/error code
 * path is exercisable end-to-end:
 *   - `{type: 'load'}`     → posts `{type: 'status', status: 'load_failed', error: 'F8 MVP: model not loaded'}`
 *   - `{type: 'predict'}`  → posts a sentinel `{type: 'result', endOfTurn: 0.5, ms: 0}`
 *
 * The host (speechRecognition.ts) does NOT consult these results in MVP.
 * The pure-VAD endpointing path remains the default behavior; this worker
 * is wired but not used for decisions. See the TODO(F8-followup) block in
 * speechRecognition.ts for the intended decision-rule call site.
 *
 * Worker contract:
 *   inbound:
 *     {type: 'load'}
 *     {type: 'predict', audio: Float32Array, partial: boolean}
 *   outbound:
 *     {type: 'status', status: 'loading'|'ready'|'load_failed'|'runtime_error', error?: string}
 *     {type: 'result', endOfTurn: number, ms: number, error?: 'runtime_error'|'inference_timeout'}
 */

type InMsg =
  | { type: 'load' }
  | { type: 'predict'; audio: Float32Array; partial: boolean }

type StatusValue = 'loading' | 'ready' | 'load_failed' | 'runtime_error'

interface StatusOut {
  type: 'status'
  status: StatusValue
  error?: string
}

interface ResultOut {
  type: 'result'
  /** Sigmoid output in [0,1]. SENTINEL value 0.5 in MVP — do not use for decisions. */
  endOfTurn: number
  /** Wall-clock inference cost in ms. 0 in MVP (no real inference). */
  ms: number
  error?: 'runtime_error' | 'inference_timeout'
}

const MVP_LOAD_FAILED_REASON = 'F8 MVP: model not loaded'

self.addEventListener('message', (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return

  if (msg.type === 'load') {
    // TODO(F8-followup): replace this stub with real ORT init.
    //   1. Download `model.onnx` (INT8) + `preprocessor_config.json` from
    //      `onnx-community/smart-turn-v3-ONNX` (HF CDN, HTTPS).
    //   2. Cache in IndexedDB; one cache-bust retry on integrity failure.
    //   3. `ort.InferenceSession.create(model, { executionProviders: ['wasm'] })`
    //      with SIMD on, threaded if `crossOriginIsolated`.
    //   4. Build a WhisperFeatureExtractor port (80 mel × 400 frames @ 16 kHz).
    //   5. Warmup against `new Float32Array(SAMPLE_RATE * 2)`.
    //   6. On success post `{type:'status', status:'ready'}`.
    const out: StatusOut = {
      type: 'status',
      status: 'load_failed',
      error: MVP_LOAD_FAILED_REASON,
    }
    self.postMessage(out)
    return
  }

  if (msg.type === 'predict') {
    // TODO(F8-followup): replace this stub with real inference.
    //   - Truncate-from-head + zero-pad-at-start to encoder input length
    //     (matching upstream Pipecat `inference.py`).
    //   - Run mel extractor → `session.run({input_features: melTensor})`.
    //   - Sigmoid the logit; post `{type:'result', endOfTurn, ms}`.
    //   - On caller-side 250 ms timeout breach, the host abandons the
    //     result; this worker has no separate cancellation channel in MVP.
    const out: ResultOut = {
      type: 'result',
      endOfTurn: 0.5,   // sentinel — never used for decisions in MVP
      ms: 0,
    }
    self.postMessage(out)
    return
  }
})

// Make this a module so TS doesn't treat it as a script.
export {}
