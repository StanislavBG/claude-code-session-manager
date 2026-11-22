import { memo } from 'react'

export type SuggestionAction = 'update' | 'delete' | 'fold' | 'keep'

export interface Suggestion {
  diff: { sign: '−' | '+' | ' '; text: string }[]
  summary: string
  action: SuggestionAction
  reason: string
  fold: { target: string; anchor: string; insert: string } | null
}

interface Props {
  fix: Suggestion
  onApply: () => void
  /** Update only: open the proposed file in the editor before writing it. */
  onEditFirst: () => void
  onDiscard: () => void
}

/** Per-action copy. `delete` is shown to the user as archive — the apply path archives, never deletes. */
export const ACTION_UI = {
  update: { label: 'UPDATE', apply: 'Apply update', hint: 'Writes the file · undoable' },
  delete: { label: 'ARCHIVE', apply: 'Archive', hint: 'Moves to .archive · undoable' },
  keep: { label: 'KEEP', apply: 'Mark verified', hint: 'Touches the file, clears age staleness' },
  fold: { label: 'FOLD', apply: 'Copy for an Epic', hint: 'Memory stays until the doc change lands' },
} as const

const DIFF_ROW = 'grid grid-cols-[20px_1fr] px-[18px] py-1.5 font-mono text-xs leading-normal border-t border-rule-inner'

/** Claude's one verdict on a memory: headline, reason, the change, and what to do with it. */
export const MemorySuggestionCard = memo(function MemorySuggestionCard({ fix, onApply, onEditFirst, onDiscard }: Props) {
  const ui = ACTION_UI[fix.action]
  return (
    <div data-testid="mx-suggestion" className="mx-9 mt-6 max-w-[700px] border border-honey rounded-[12px] overflow-hidden bg-bg-hi shadow-sm">
      <div className="px-[18px] py-2.5 bg-butter/40 flex items-center gap-2 text-honey-dark">
        <span aria-hidden className="text-[13px]">+</span>
        <span data-testid="mx-suggestion-head" className="text-[11px] tracking-[.1em] font-semibold">
          CLAUDE SUGGESTS · {ui.label}
        </span>
        <span className="flex-1" />
        <span className="text-[11.5px]">one of keep · update · archive · fold</span>
      </div>
      <div className="px-[18px] py-3 flex flex-col gap-1">
        <span data-testid="mx-reader-summary" className="text-[15px] font-semibold text-fg">{fix.summary}</span>
        {fix.reason && (
          <span data-testid="mx-reader-reason" className="text-[13px] leading-normal text-fg-dim">{fix.reason}</span>
        )}
      </div>
      {fix.action === 'fold' && fix.fold && (
        <div data-testid="mx-suggestion-fold">
          <div className="px-[18px] py-1.5 border-t border-rule-inner text-[11.5px] text-fg-dim font-mono break-all">
            {fix.fold.target} · {fix.fold.anchor || 'append at end'}
          </div>
          {fix.fold.insert.split('\n').map((line, i) => (
            <div key={i} className={`${DIFF_ROW} bg-sage/20 text-sage-dark`}>
              <span>+</span>
              <span className="whitespace-pre-wrap break-words">{line}</span>
            </div>
          ))}
        </div>
      )}
      {fix.action === 'update' && (
        <div data-testid="mx-suggestion-diff">
          {fix.diff.map((d, i) => (
            <div
              key={i}
              className={`${DIFF_ROW} ${
                d.sign === '−' ? 'bg-accent-muted/30 text-accent-dark' : d.sign === '+' ? 'bg-sage/20 text-sage-dark' : 'text-fg-dim'
              }`}
            >
              <span>{d.sign}</span>
              <span className="whitespace-pre-wrap break-words">{d.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 px-[18px] py-3 border-t border-rule-structural items-center">
        <button
          type="button"
          data-testid="mx-reader-apply"
          onClick={onApply}
          className="text-[13.5px] font-semibold h-9 px-4 rounded-[9px] bg-accent text-bg-hi hover:bg-accent/90"
        >
          {ui.apply}
        </button>
        {fix.action === 'update' && (
          <button
            type="button"
            data-testid="mx-reader-edit-first"
            onClick={onEditFirst}
            className="text-[13.5px] font-semibold h-9 px-3.5 rounded-[9px] border border-fg text-fg"
          >
            Edit first
          </button>
        )}
        <button
          type="button"
          data-testid="mx-reader-discard"
          onClick={onDiscard}
          className="text-[13.5px] font-medium h-9 px-3.5 rounded-[9px] border border-rule-structural text-fg"
        >
          Discard
        </button>
        <span className="flex-1" />
        <span className="text-[12.5px] text-fg-dim">{ui.hint}</span>
      </div>
    </div>
  )
})
