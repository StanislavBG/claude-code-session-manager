/**
 * EditorStatusBar — the document editor's bottom strip (DESIGN_SPEC §3):
 *
 *   ● Saved · matches the file on disk   N words · ~N tokens   Ln x, Col y · Markdown   Revert   Save Ctrl S
 *
 * Metrics are derived from the buffer in one memoized O(n) pass; `~tokens` is
 * the usual chars/4 estimate of what the file costs in context.
 *
 * The save-state half (dot + text, Revert, Save) only renders when the host
 * passes `saveState` — hosts that own their own save bar (EditorView) keep the
 * metrics-only strip. Revert and Save are enabled only when the buffer is dirty.
 */

import { useMemo } from 'react'

interface CursorInfo {
  line: number
  col: number
  selected: number
}

export type SaveState = 'saved' | 'dirty' | 'new'

interface Props {
  text: string
  cursor: CursorInfo | null
  language?: string
  /** Position label override, e.g. "Document · saved as Markdown" when no cursor applies. */
  positionLabel?: string
  /** Opt-in save chrome. Omit to render the metrics-only strip. */
  saveState?: SaveState
  /** True when the buffer differs from disk — gates Save and Revert. */
  dirty?: boolean
  /** The file does not exist on disk yet — Save reads "Create file". */
  isNew?: boolean
  onSave?: () => void
  onRevert?: () => void
}

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'Saved · matches the file on disk',
  dirty: 'Unsaved changes',
  new: 'New file · created on first save',
}

// Literal class strings (Tailwind JIT) — sage saved / honey dirty / accent new.
const SAVE_DOT: Record<SaveState, string> = {
  saved: 'bg-sage',
  dirty: 'bg-honey',
  new: 'bg-accent',
}

export function countWords(s: string): number {
  const m = s.trim()
  if (!m) return 0
  return m.split(/\s+/).length
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

export function SaveDot({ state, className = '' }: { state: SaveState; className?: string }) {
  return (
    <span
      aria-hidden
      data-save-state={state}
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${SAVE_DOT[state]} ${className}`}
    />
  )
}

export function EditorStatusBar({ text, cursor, language, positionLabel, saveState, dirty, isNew, onSave, onRevert }: Props) {
  const { words, tokens } = useMemo(() => ({ words: countWords(text), tokens: estimateTokens(text) }), [text])

  return (
    <div data-testid="editor-status-bar" className="flex items-center gap-3 px-3 h-7 shrink-0 border-t border-line bg-bg-elev text-[10px] text-fg-faint">
      {saveState && (
        <span className="flex items-center gap-1.5 text-fg-dim">
          <SaveDot state={saveState} />
          <span data-testid="editor-save-state">{SAVE_TEXT[saveState]}</span>
        </span>
      )}
      <span>
        {words.toLocaleString()} words · ~{tokens.toLocaleString()} tokens
      </span>
      <div className="flex-1" />
      {cursor ? (
        <>
          {cursor.selected > 0 && <span>{cursor.selected.toLocaleString()} selected</span>}
          <span className="font-mono">
            Ln {cursor.line}, Col {cursor.col}
            {language && <span className="uppercase"> · {language}</span>}
          </span>
        </>
      ) : positionLabel ? (
        <span className="font-mono">{positionLabel}</span>
      ) : (
        language && <span className="uppercase font-mono">{language}</span>
      )}
      {saveState && (
        <>
          <button
            type="button"
            data-testid="editor-revert"
            disabled={!dirty || !onRevert}
            onClick={() => onRevert?.()}
            className="px-1.5 py-0.5 rounded text-fg-dim hover:text-fg disabled:opacity-40 disabled:hover:text-fg-dim disabled:cursor-default"
          >
            Revert
          </button>
          <button
            type="button"
            data-testid="editor-save"
            disabled={!dirty || !onSave}
            onClick={() => onSave?.()}
            className="px-2.5 py-0.5 rounded bg-accent text-bg-hi font-medium disabled:opacity-40 disabled:cursor-default"
          >
            {saveState === 'new' || isNew ? 'Create file' : 'Save'}
            <span className="ml-1.5 font-mono text-[9px] opacity-80">Ctrl S</span>
          </button>
        </>
      )}
    </div>
  )
}
