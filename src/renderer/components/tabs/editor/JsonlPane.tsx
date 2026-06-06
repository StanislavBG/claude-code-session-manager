/**
 * JsonlPane — record-oriented CRUD view for JSON Lines (.jsonl) files.
 *
 * JSONL is the dominant file type under ~/.claude/projects (the transcripts):
 * one JSON value per line. This pane renders each line as an expandable record
 * card and offers full CRUD — add / edit / delete — on records. The buffer text
 * is the single source of truth: every mutation re-serializes and pushes back
 * through useEditor.setBuffer, so dirty-tracking, save, and autosave all apply
 * for free. Edits are non-destructive: only the line you change is re-serialized
 * (compact); untouched lines keep their exact original bytes. Malformed lines
 * stay visible (flagged) and editable rather than being dropped.
 *
 * Records are capped for DOM safety; the cap is surfaced (no silent truncation) —
 * switch to Edit to see the whole file as raw text.
 */

import { useMemo, useState } from 'react'
import { useEditor } from '../../../state/editor'
import { toast } from '../../../state/toast'

const MAX_RECORDS = 2000

interface Rec {
  /** Index into the raw `lines` array — stable identity for mutations. */
  line: number
  raw: string
  /** Parsed value, or undefined if the line is not valid JSON. */
  value?: unknown
  error?: string
}

/** Split buffer into records, keeping raw text + parse status per non-blank line.
 *  O(n) over lines. Blank lines are skipped for display but preserved on write
 *  (mutations index back into the original `lines` array). */
function parseRecords(lines: string[]): Rec[] {
  const recs: Rec[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    try {
      recs.push({ line: i, raw, value: JSON.parse(raw) })
    } catch (e) {
      recs.push({ line: i, raw, error: (e as Error).message })
    }
    if (recs.length >= MAX_RECORDS) break
  }
  return recs
}

/** One-line summary for a collapsed record: the `type` field if present, else
 *  the first key, else a clipped raw preview. */
function summarize(r: Rec): string {
  if (r.error) return 'malformed JSON'
  const v = r.value
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const obj = v as Record<string, unknown>
    if (typeof obj.type === 'string') {
      const extra = obj.role ?? obj.operation ?? obj.name
      return typeof extra === 'string' ? `${obj.type} · ${extra}` : obj.type
    }
    const keys = Object.keys(obj)
    return keys.length ? `{ ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''} }` : '{}'
  }
  return r.raw.slice(0, 80)
}

export function JsonlPane({ path, text }: { path: string; text: string }) {
  const setBuffer = useEditor((s) => s.setBuffer)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  const lines = useMemo(() => text.split('\n'), [text])
  const recs = useMemo(() => parseRecords(lines), [lines])
  const truncated = lines.filter((l) => l.trim() !== '').length > MAX_RECORDS

  /** Live buffer split into lines. Mutations MUST index into this, not the
   *  memoized `lines`: autosave or an external buffer update can advance
   *  buffers[path] past the last render, and indexing a stale `lines` would
   *  write the edit/delete onto the wrong record. Falls back to the `text`
   *  prop before the first setBuffer. */
  const liveLines = () => (useEditor.getState().buffers[path] ?? text).split('\n')

  /** Rejoin a mutated copy and push it back to the buffer. */
  const commit = (next: string[]) => setBuffer(path, next.join('\n'))

  const beginEdit = (r: Rec) => {
    setEditing(r.line)
    setDraftError(null)
    // Pretty-print valid JSON for editing; leave malformed lines as-is to fix.
    setDraft(r.error ? r.raw : JSON.stringify(r.value, null, 2))
  }

  const saveEdit = (lineIdx: number) => {
    let compact: string
    try {
      compact = JSON.stringify(JSON.parse(draft))
    } catch (e) {
      setDraftError((e as Error).message)
      return
    }
    const next = liveLines()
    next[lineIdx] = compact
    commit(next)
    setEditing(null)
  }

  const deleteRecord = (lineIdx: number) => {
    const next = liveLines()
    next.splice(lineIdx, 1)
    commit(next)
    // Transient UI state is keyed by line index; deleting shifts every index
    // below lineIdx down by one. Re-map editing/expanded so they keep pointing
    // at the same records — otherwise an open editor's draft would be saved over
    // the wrong (shifted) record.
    if (editing === lineIdx) {
      setEditing(null)
      setDraftError(null)
    } else if (editing !== null && editing > lineIdx) {
      setEditing(editing - 1)
    }
    setExpanded((s) => {
      const n = new Set<number>()
      for (const i of s) {
        if (i === lineIdx) continue
        n.add(i > lineIdx ? i - 1 : i)
      }
      return n
    })
  }

  const addRecord = () => {
    const next = liveLines()
    // Insert after the last non-blank line so a trailing newline stays trailing.
    let at = next.length
    while (at > 0 && next[at - 1].trim() === '') at--
    next.splice(at, 0, '{}')
    commit(next)
    // The record list shows only the first MAX_RECORDS; on a truncated file the
    // appended record is past the cap, so opening an inline editor on it would
    // render nothing. Append still succeeds — point the user at Edit mode.
    if (truncated) {
      toast.info('Record added at end of file — switch to Edit to see it.')
      return
    }
    setEditing(at)
    setDraft('{\n  \n}')
    setDraftError(null)
    setExpanded((s) => new Set(s).add(at))
  }

  const toggle = (line: number) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(line)) n.delete(line)
      else n.add(line)
      return n
    })

  return (
    <div className="h-full overflow-auto bg-bg text-xs">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 bg-bg-elev border-b border-line">
        <span className="text-fg-faint tabular-nums">
          {recs.length.toLocaleString()} record{recs.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={addRecord}
          className="px-2 py-0.5 text-[11px] text-fg-dim hover:text-fg border border-line rounded"
        >
          + Add record
        </button>
        {truncated && (
          <span className="text-[10px] text-amber-700">
            Showing first {MAX_RECORDS.toLocaleString()} — switch to Edit for the full file.
          </span>
        )}
      </div>

      {recs.length === 0 ? (
        <div className="p-6 text-fg-faint">empty file</div>
      ) : (
        <ul className="divide-y divide-line">
          {recs.map((r, ri) => {
            const isOpen = expanded.has(r.line) || editing === r.line
            return (
              <li key={r.line} className={r.error ? 'bg-red-500/5' : ''}>
                <div className="flex items-start gap-2 px-3 py-1.5">
                  <span className="w-10 shrink-0 text-right text-fg-faint tabular-nums select-none">{ri + 1}</span>
                  <button
                    onClick={() => toggle(r.line)}
                    className="flex-1 min-w-0 text-left"
                    title={isOpen ? 'Collapse' : 'Expand'}
                  >
                    <span className={`mr-1 inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>›</span>
                    <span className={r.error ? 'text-red-400' : 'text-fg-dim'}>{summarize(r)}</span>
                  </button>
                  <div className="flex shrink-0 gap-2">
                    {editing !== r.line && (
                      <button onClick={() => beginEdit(r)} className="text-fg-faint hover:text-fg">Edit</button>
                    )}
                    <button onClick={() => deleteRecord(r.line)} className="text-fg-faint hover:text-red-400">Delete</button>
                  </div>
                </div>

                {isOpen && editing === r.line && (
                  <div className="px-3 pb-2 pl-12">
                    <textarea
                      value={draft}
                      onChange={(e) => { setDraft(e.target.value); setDraftError(null) }}
                      spellCheck={false}
                      rows={Math.min(20, draft.split('\n').length + 1)}
                      className="w-full font-mono text-[11px] bg-bg border border-line rounded p-2 text-fg outline-none focus:border-fg-faint resize-y"
                    />
                    {draftError && <div className="mt-1 text-[10px] text-red-400">Invalid JSON: {draftError}</div>}
                    <div className="mt-1 flex gap-2">
                      <button
                        onClick={() => saveEdit(r.line)}
                        className="px-2 py-0.5 text-[11px] text-white bg-blue-600 hover:bg-blue-500 rounded"
                      >
                        Save record
                      </button>
                      <button
                        onClick={() => { setEditing(null); setDraftError(null) }}
                        className="px-2 py-0.5 text-[11px] text-fg-dim hover:text-fg border border-line rounded"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {isOpen && editing !== r.line && (
                  <pre className="px-3 pb-2 pl-12 font-mono text-[11px] text-fg-dim whitespace-pre-wrap break-all">
                    {r.error ? r.raw : JSON.stringify(r.value, null, 2)}
                  </pre>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
