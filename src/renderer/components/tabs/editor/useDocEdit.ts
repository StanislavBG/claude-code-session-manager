/**
 * useDocEdit — phase machine driving the Document Experience inline rewrite
 * flow (PRD 639): select a preview span → popover → thinking → diff review.
 *
 * Owned by EditorView (not MarkdownPreview) so the same instance survives
 * across preview/split-mode remounts and can reach the buffer store on
 * Accept. `accept` is a pure computation over the buffer text handed in by
 * the caller — EditorView is the one that actually calls `setBuffer`.
 */

import { useCallback, useRef, useState } from 'react'
import { toast } from '../../../state/toast'
import { applySpanEdit, type ApplySpanEditResult } from '../../../lib/applySpanEdit'

export interface SelectionRect {
  top: number
  left: number
  bottom: number
  right: number
}

export interface SelectionInfo {
  text: string
  rect: SelectionRect
}

export type DocEditPhase = 'idle' | 'popover' | 'thinking' | 'diff'

interface DocEditDiff {
  before: string
  after: string
}

interface DocEditState {
  phase: DocEditPhase
  selection: SelectionInfo | null
  instruction: string
  diff: DocEditDiff | null
}

const IDLE_STATE: DocEditState = { phase: 'idle', selection: null, instruction: '', diff: null }

export function useDocEdit(path: string) {
  const [state, setState] = useState<DocEditState>(IDLE_STATE)
  // Bumped on every cancel/select/accept so an in-flight docEdit.run resolving
  // after the user moved on (cancelled, re-selected) is a no-op — "Cancel
  // abandons the result (ignore the resolved promise)".
  const tokenRef = useRef(0)

  const select = useCallback((selection: SelectionInfo) => {
    tokenRef.current += 1
    setState({ phase: 'popover', selection, instruction: '', diff: null })
  }, [])

  const cancel = useCallback(() => {
    tokenRef.current += 1
    setState(IDLE_STATE)
  }, [])

  const runInstruction = useCallback(async (instruction: string, recordInstruction: boolean) => {
    const selection = state.selection
    if (!selection) return
    const myToken = ++tokenRef.current
    setState((s) => ({ ...s, phase: 'thinking', instruction: recordInstruction ? instruction : s.instruction }))
    const r = await window.api.docEdit.run({ path, before: selection.text, instruction })
    if (tokenRef.current !== myToken) return
    if (!r.ok) {
      toast.error(r.error || 'Edit failed')
      setState((s) => ({ ...s, phase: 'popover' }))
      return
    }
    setState((s) => ({ ...s, phase: 'diff', diff: { before: selection.text, after: r.after ?? '' } }))
  }, [path, state.selection])

  const run = useCallback((instruction: string) => { void runInstruction(instruction, true) }, [runInstruction])

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
      setState(IDLE_STATE)
    } else {
      toast.error(
        result.reason === 'ambiguous'
          ? 'That text appears more than once — edit it manually instead.'
          : 'That text no longer matches the document — edit it manually instead.',
      )
    }
    return result
  }, [state.diff])

  return { state, select, cancel, run, retry, accept }
}
