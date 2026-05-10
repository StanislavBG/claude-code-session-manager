/**
 * User-facing copy for the mic button gate. Kept out of the store so the
 * predicate (selectCanRecord) stays pure and reusable by F1's hotkey path.
 */

import type { GateReason } from '../state/voice'

export interface CopyContext {
  loadingPct?: number
  errorMessage?: string | null
  isRecording?: boolean
}

export function copyFor(reason: GateReason, ctx: CopyContext = {}): string {
  switch (reason) {
    case 'ready':
      return ctx.isRecording
        ? 'Stop voice input'
        : 'Start voice input (local Whisper, offline)'
    case 'idle':
      return 'Microphone — speech model not started'
    case 'loading': {
      const pct = typeof ctx.loadingPct === 'number' ? Math.round(ctx.loadingPct) : 0
      return `Microphone — loading speech model, ${pct} percent`
    }
    case 'error':
      return ctx.errorMessage
        ? `Microphone — speech model error: ${ctx.errorMessage}. Activate to retry.`
        : 'Microphone — speech model error. Activate to retry.'
    case 'load-timeout':
      return 'Microphone — model load timed out. Activate to retry.'
    case 'permission-denied':
      return 'Microphone — permission denied. Open OS settings.'
    case 'unsupported':
      return 'Microphone — voice input not supported in this build.'
  }
}
