/**
 * useDocEdit — phase machine driving the Document Experience inline rewrite
 * flow: select a preview span → popover → (optional voice: listening →
 * review) → thinking → diff review.
 *
 * Owned by EditorView (not MarkdownPreview) so the same instance survives
 * across preview/split-mode remounts and can reach the buffer store on
 * Accept. `accept` is a pure computation over the buffer text handed in by
 * the caller — EditorView is the one that actually calls `setBuffer`.
 *
 * Pure phase transitions live in docEditReducer.ts (unit-tested there
 * without DOM/audio); this hook only adds the IO: the docEdit.run IPC call
 * and the voice capture path.
 *
 * Voice capture uses `createRecognition` directly (the same primitive
 * state/voice.ts wraps) rather than going through the voice store's
 * startRecording/onFinal — that path's onFinal is the app's ONE
 * pty-submitting call site (voice.ts:~630) and must stay that way. We only
 * borrow the voice store's `isRecording` flag (via setState) so the
 * App-level RecordingStatus privacy banner — which is keyed off that same
 * flag — mounts for this capture too.
 */

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { toast } from '../../../state/toast'
import { useVoice } from '../../../state/voice'
import { useSessions } from '../../../state/sessions'
import { useLive } from '../../../state/live'
import { useChat } from '../../../state/chat'
import { createRecognition, isRecognitionSupported } from '../../../lib/speechRecognition'
import { applySpanEdit, type ApplySpanEditResult } from '../../../lib/applySpanEdit'
import { truncateDocumentText } from '../../../lib/truncateDocumentText'
import { docEditReducer, IDLE_STATE, LISTEN_FROM, type SelectionInfo } from './docEditReducer'
import { resolveProjectCwd, findBackgroundSession } from './findBackgroundSession'
import type { DocEditSessionResult } from '../../../../preload/api'

export type { SelectionRect, SelectionInfo, DocEditPhase } from './docEditReducer'

/** Pinned by src/main/docEdit.cjs's runClaude default — single source of truth for the rail's model pill. */
export const DOCEDIT_MODEL = 'sonnet'

export function useDocEdit(path: string, documentText: string) {
  const [state, dispatch] = useReducer(docEditReducer, IDLE_STATE)
  // Bumped on every cancel/select/accept/listen so an in-flight async
  // callback (docEdit.run resolving, recognition onFinal/onError firing)
  // that lands after the user moved on is a no-op — "Cancel abandons the
  // result (ignore the resolved promise)".
  const tokenRef = useRef(0)
  const recognitionRef = useRef<ReturnType<typeof createRecognition> | null>(null)
  const pathRef = useRef(path)
  // Pending docedit:run-in-session requests awaiting their async
  // docedit:session-result broadcast, keyed by requestId.
  const pendingSessionRequestsRef = useRef(new Map<string, (result: DocEditSessionResult) => void>())

  useEffect(() => {
    return window.api.docEdit.onSessionResult((result) => {
      const resolve = pendingSessionRequestsRef.current.get(result.requestId)
      if (!resolve) return
      pendingSessionRequestsRef.current.delete(result.requestId)
      resolve(result)
    })
  }, [])

  // Edits-this-session counter resets per file — this hook is one instance
  // reused across the whole EditorView, so a change of `path` (not a remount)
  // is what marks "new file".
  useEffect(() => {
    if (pathRef.current !== path) {
      pathRef.current = path
      tokenRef.current += 1
      stopRecognition()
      dispatch({ type: 'RESET_FILE' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  function stopRecognition() {
    const handle = recognitionRef.current
    if (!handle) return
    recognitionRef.current = null
    // Rejections here are drain-cleanup noise, not actionable — the handle
    // is being torn down regardless (mirrors the same swallow in voice.ts).
    handle.stop().catch(() => {})
    handle.destroy()
    useVoice.setState({ externalRecording: false })
  }

  const select = useCallback((selection: SelectionInfo) => {
    tokenRef.current += 1
    stopRecognition()
    dispatch({ type: 'SELECT', selection })
  }, [])

  const cancel = useCallback(() => {
    tokenRef.current += 1
    stopRecognition()
    dispatch({ type: 'CANCEL' })
  }, [])

  const listen = useCallback(() => {
    if (!LISTEN_FROM.includes(state.phase)) return
    if (useVoice.getState().isRecording) {
      toast.error('Microphone is already in use')
      return
    }
    if (!isRecognitionSupported()) {
      toast.error('Microphone or Web Worker not available')
      return
    }
    const myToken = ++tokenRef.current
    dispatch({ type: 'LISTEN' })
    useVoice.setState({ externalRecording: true })

    const finish = () => {
      if (recognitionRef.current === handle) recognitionRef.current = null
      useVoice.setState({ externalRecording: false })
    }

    const handle = createRecognition({
      onFinal: (text) => {
        if (tokenRef.current !== myToken) return
        handle.stop().catch(() => {})
        handle.destroy()
        finish()
        const trimmed = text.trim()
        if (!trimmed) {
          dispatch({ type: 'CANCEL' })
          return
        }
        dispatch({ type: 'HEARD', transcript: trimmed })
      },
      onError: (err) => {
        if (tokenRef.current !== myToken) return
        handle.destroy()
        finish()
        toast.error(`Microphone error: ${err}`)
        dispatch({ type: 'CANCEL' })
      },
      onModelStatus: (status, message) => {
        if (tokenRef.current !== myToken) return
        dispatch({ type: 'MODEL_STATUS', status, message })
      },
      onProgress: (pct) => {
        if (tokenRef.current !== myToken) return
        dispatch({ type: 'MODEL_STATUS', status: 'loading', message: `${pct}%` })
      },
    })
    recognitionRef.current = handle
    handle.start().catch((e: unknown) => {
      if (tokenRef.current !== myToken) return
      handle.destroy()
      finish()
      toast.error(`Could not start mic: ${e instanceof Error ? e.message : String(e)}`)
      dispatch({ type: 'CANCEL' })
    })
  }, [state.phase])

  // Resolve a dormant, same-project background chat session to append this
  // edit onto instead of spawning an isolated claude -p (PRD 680). Never
  // targets a running/spawning tab's claudeSessionId — only a dormant tab's
  // chatSessionId, and only when that tab isn't already mid-run.
  const findIdleBackgroundSession = useCallback(() => {
    const targetCwd = resolveProjectCwd(path, useSessions.getState().tabs)
    if (!targetCwd) return null
    const candidate = findBackgroundSession(targetCwd, useSessions.getState().tabs, useLive.getState().tabs)
    if (!candidate) return null
    if (useChat.getState().get(candidate.id).running) return null
    return candidate
  }, [path])

  const runViaSession = useCallback((tabId: string, sessionId: string, cwd: string, before: string, instruction: string, docText: string) => {
    const requestId = `docedit-${Date.now()}-${Math.random().toString(36).slice(2)}`
    return new Promise<DocEditSessionResult>((resolve) => {
      pendingSessionRequestsRef.current.set(requestId, resolve)
      void window.api.docEdit.runInSession({ tabId, sessionId, cwd, before, instruction, documentText: docText, requestId })
    })
  }, [])

  const runInstruction = useCallback(async (instruction: string, recordInstruction: boolean) => {
    const selection = state.selection
    if (!selection) return
    const myToken = ++tokenRef.current
    dispatch({ type: 'RUN', instruction, recordInstruction })
    const docText = truncateDocumentText(documentText)
    try {
      const backgroundSession = findIdleBackgroundSession()
      const r = backgroundSession
        ? await runViaSession(backgroundSession.id, backgroundSession.chatSessionId, backgroundSession.cwd, selection.text, instruction, docText)
        : await window.api.docEdit.run({ path, before: selection.text, instruction, documentText: docText })
      if (tokenRef.current !== myToken) return
      if (!r.ok) {
        toast.error(r.error || 'Edit failed')
        dispatch({ type: 'RUN_ERR' })
        return
      }
      dispatch({ type: 'RUN_OK', diff: { before: selection.text, after: r.after ?? '' } })
    } catch (e: unknown) {
      if (tokenRef.current !== myToken) return
      toast.error(e instanceof Error ? e.message : 'Edit failed')
      dispatch({ type: 'RUN_ERR' })
    }
  }, [path, state.selection, documentText, findIdleBackgroundSession, runViaSession])

  const run = useCallback((instruction: string) => { void runInstruction(instruction, true) }, [runInstruction])

  const sendHeard = useCallback(() => {
    if (state.phase !== 'review') return
    void runInstruction(state.transcript, true)
  }, [runInstruction, state.phase, state.transcript])

  const retry = useCallback(() => {
    const instruction = state.instruction
    if (!instruction) return
    void runInstruction(`${instruction}\n\n(Give a different rewrite than the last one.)`, false)
  }, [runInstruction, state.instruction])

  const accept = useCallback((buffer: string): ApplySpanEditResult => {
    const diff = state.diff
    if (!diff) return { ok: false, reason: 'not-found' }
    const result = applySpanEdit(buffer, diff.before, diff.after)
    if (result.ok) {
      tokenRef.current += 1
      dispatch({ type: 'ACCEPT' })
    } else {
      toast.error(
        result.reason === 'ambiguous'
          ? 'That text appears more than once — edit it manually instead.'
          : 'That text no longer matches the document — edit it manually instead.',
      )
    }
    return result
  }, [state.diff])

  return { state, select, cancel, listen, sendHeard, run, retry, accept }
}
