/**
 * SelectionPopover — the Document Experience quick-action popover + diff
 * review card, anchored above a captured preview selection (useDocEdit).
 *
 * Three phases render here: `popover` (quick-action chips + free-text
 * command box), `thinking` (pulsing status + Cancel), `diff` (old/new review
 * card with Accept/Reject/Retry). Positioning is viewport-fixed, clamped to
 * stay inside the pane.
 */

import { useState } from 'react'
import type { SelectionRect } from './useDocEdit'

const QUICK_ACTIONS: { label: string; instruction: string }[] = [
  { label: 'Make concise', instruction: 'Rewrite this text to be concise and specific. Preserve meaning and any markdown structure.' },
  { label: 'To bullet list', instruction: 'Convert this text into a tight markdown bullet list.' },
  { label: 'Fix the tone', instruction: 'Fix the tone: direct, professional, no hedging. Preserve meaning.' },
]

const POPOVER_WIDTH = 320
const GAP = 8

interface Props {
  phase: 'popover' | 'thinking' | 'diff'
  rect: SelectionRect
  diff: { before: string; after: string } | null
  onQuickAction: (instruction: string) => void
  onRunCustom: (instruction: string) => void
  onCancel: () => void
  onAccept: () => void
  onReject: () => void
  onRetry: () => void
}

function clampedStyle(rect: SelectionRect): React.CSSProperties {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const left = Math.min(Math.max(rect.left, GAP), Math.max(GAP, vw - POPOVER_WIDTH - GAP))
  const top = Math.max(rect.top - GAP, GAP)
  return {
    position: 'fixed',
    left,
    top,
    width: POPOVER_WIDTH,
    transform: 'translateY(-100%)',
    zIndex: 50,
  }
}

export function SelectionPopover({ phase, rect, diff, onQuickAction, onRunCustom, onCancel, onAccept, onReject, onRetry }: Props) {
  const [custom, setCustom] = useState('')

  const submitCustom = () => {
    const trimmed = custom.trim()
    if (!trimmed) return
    onRunCustom(trimmed)
    setCustom('')
  }

  return (
    <div
      data-doc-edit-popover
      style={clampedStyle(rect)}
      className="rounded-lg border border-line bg-bg-elev shadow-2xl text-xs text-fg"
    >
      {phase === 'popover' && (
        <div className="p-2">
          <div className="flex items-center justify-between mb-2">
            <div className="flex flex-wrap gap-1">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  onClick={() => onQuickAction(a.instruction)}
                  className="px-2 py-1 text-[11px] rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi"
                >
                  {a.label}
                </button>
              ))}
            </div>
            <button onClick={onCancel} className="ml-2 shrink-0 text-fg-faint hover:text-fg" title="Dismiss" aria-label="Dismiss">
              ×
            </button>
          </div>
          <input
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom()
              else if (e.key === 'Escape') onCancel()
            }}
            placeholder="tell Claude what to change…"
            className="w-full px-2 py-1 text-[11px] bg-bg border border-line rounded outline-none focus:border-fg-faint text-fg placeholder:text-fg-faint"
          />
        </div>
      )}

      {phase === 'thinking' && (
        <div className="p-3 flex items-center justify-between">
          <span className="text-fg-dim animate-pulse">Claude is editing…</span>
          <button onClick={onCancel} className="px-2 py-0.5 text-[11px] text-fg-faint hover:text-fg border border-line rounded">
            Cancel
          </button>
        </div>
      )}

      {phase === 'diff' && diff && (
        <div className="p-3">
          <div className="mb-2 max-h-40 overflow-auto space-y-1">
            <div className="text-red-400 line-through whitespace-pre-wrap">{diff.before}</div>
            <div className="text-green-400 whitespace-pre-wrap">{diff.after}</div>
          </div>
          <div className="flex justify-end gap-1.5">
            <button onClick={onReject} className="px-2 py-1 text-[11px] text-fg-faint hover:text-fg border border-line rounded">
              Reject
            </button>
            <button onClick={onRetry} className="px-2 py-1 text-[11px] text-fg-dim hover:text-fg border border-line rounded">
              Retry
            </button>
            <button onClick={onAccept} className="px-2 py-1 text-[11px] text-white rounded bg-green-600 hover:bg-green-500">
              Accept
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
