// Web build stub: voice/VAD/whisper/onnx are excluded from the browser bundle.
export type RecognitionStatus = 'transcribing' | 'restarting' | 'idle'
export const TURN_DETECTOR_MIN_AUDIO_MS = 1500
export const TURN_DETECTOR_TIMEOUT_MS = 250
export const VAD_DEFAULT_POSITIVE = 0.5
export const VAD_DEFAULT_NEGATIVE = 0.35
export const VAD_DUCKED_POSITIVE = 0.85
export const VAD_DUCKED_NEGATIVE = 0.7
export interface RecognitionHandle { start: () => void; stop: () => void; [k: string]: unknown }
export function __resetWorkerDeathStateForTests(): void {}
export function preloadModel(..._a: unknown[]): void {}
export function resetModel(): void {}
export function releaseModel(): void {}
export function isRecognitionSupported(): boolean { return false }
export function transcribeOnce(_audio: Float32Array): Promise<string> {
  return Promise.reject(new Error('Not available in the web version'))
}
export function createRecognition(_opts: unknown): RecognitionHandle {
  throw new Error('Not available in the web version')
}
