// Presentational unified-diff view for ONE DiffFile, with per-line comment
// anchors. Holds only local editor state — the parent owns the comments and
// receives every add/update/remove through the callbacks. No store reads.
import { Fragment, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { DiffFile, DiffHunk, DiffLine } from '../../../preload/api'
import type { ReviewComment, ReviewSide } from '../../lib/reviewMessage'

export interface DiffCommentAnchor {
  path: string
  side: ReviewSide
  startLine: number
  endLine: number
  lineText: string
}

export interface DiffFileViewProps {
  file: DiffFile
  comments: ReviewComment[]
  defaultCollapsed?: boolean
  readOnly?: boolean
  onAddComment(anchor: DiffCommentAnchor, body: string): void
  onUpdateComment(id: string, body: string): void
  onRemoveComment(id: string): void
}

interface EditorState {
  hunk: number
  side: ReviewSide
  /** The line first clicked; a shift-click extends the range from here. */
  anchorLine: number
  startLine: number
  endLine: number
}

const STATUS_BADGE: Record<DiffFile['status'], { label: string; cls: string }> = {
  added: { label: 'added', cls: 'bg-sage/20 text-sage-dark' },
  deleted: { label: 'deleted', cls: 'bg-accent/15 text-accent-dark' },
  modified: { label: 'modified', cls: 'bg-butter/25 text-fg-dim' },
  renamed: { label: 'renamed', cls: 'bg-fg-dim/10 text-fg-dim' },
}

const ROW_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-sage/15',
  del: 'bg-accent/10',
  ctx: '',
}

const MARKER: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ' }

/** The side + line a row's comment button anchors to. */
function rowAnchor(line: DiffLine): { side: ReviewSide; line: number } | null {
  if (line.kind === 'del') return line.oldNo == null ? null : { side: 'old', line: line.oldNo }
  return line.newNo == null ? null : { side: 'new', line: line.newNo }
}

function lineNoFor(line: DiffLine, side: ReviewSide): number | null {
  return side === 'old' ? line.oldNo : line.newNo
}

function coveredText(hunk: DiffHunk, side: ReviewSide, start: number, end: number): string {
  return hunk.lines
    .filter((l) => {
      if (side === 'old' ? l.kind === 'add' : l.kind === 'del') return false
      const n = lineNoFor(l, side)
      return n != null && n >= start && n <= end
    })
    .map((l) => l.text)
    .join('\n')
}

function isSaveKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey)
}

function CommentEditor({
  value,
  onChange,
  onSave,
  onCancel,
  label,
  testIdPrefix,
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  onCancel: () => void
  label: string
  testIdPrefix: string
}) {
  return (
    <div className="border-y border-line bg-bg-elev px-3 py-2 font-sans">
      <div className="mb-1 text-[11px] text-fg-faint">{label}</div>
      <textarea
        data-testid={`${testIdPrefix}-input`}
        autoFocus
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (isSaveKey(e)) {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        className="w-full resize-y rounded border border-line bg-bg-hi p-2 text-[12px] text-fg"
        placeholder="Leave a comment for the agent… (Ctrl/Cmd+Enter to save)"
      />
      <div className="mt-1 flex justify-end gap-2">
        <button
          type="button"
          data-testid={`${testIdPrefix}-cancel`}
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-[12px] text-fg-dim hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-save`}
          onClick={onSave}
          className="rounded bg-accent px-2 py-0.5 text-[12px] text-white"
        >
          Save
        </button>
      </div>
    </div>
  )
}

export function DiffFileView({
  file,
  comments,
  defaultCollapsed = false,
  readOnly = false,
  onAddComment,
  onUpdateComment,
  onRemoveComment,
}: DiffFileViewProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const commentsByRow = useMemo(() => {
    const map = new Map<string, ReviewComment[]>()
    for (const c of comments) {
      const key = `${c.side}:${c.endLine}`
      const list = map.get(key)
      if (list) list.push(c)
      else map.set(key, [c])
    }
    return map
  }, [comments])

  const closeEditor = () => {
    setEditor(null)
    setDraft('')
  }

  const onPlus = (e: MouseEvent<HTMLButtonElement>, hunkIdx: number, side: ReviewSide, line: number) => {
    if (e.shiftKey && editor && editor.side === side && editor.hunk === hunkIdx) {
      setEditor({
        ...editor,
        startLine: Math.min(editor.anchorLine, line),
        endLine: Math.max(editor.anchorLine, line),
      })
      return
    }
    setEditor({ hunk: hunkIdx, side, anchorLine: line, startLine: line, endLine: line })
    setDraft('')
  }

  const saveNew = () => {
    if (!editor) return
    const body = draft.trim()
    if (!body) return
    const hunk = file.hunks[editor.hunk]
    onAddComment(
      {
        path: file.path,
        side: editor.side,
        startLine: editor.startLine,
        endLine: editor.endLine,
        lineText: hunk ? coveredText(hunk, editor.side, editor.startLine, editor.endLine) : '',
      },
      body,
    )
    closeEditor()
  }

  const saveEdit = () => {
    if (!editingId) return
    const body = editText.trim()
    if (!body) return
    onUpdateComment(editingId, body)
    setEditingId(null)
    setEditText('')
  }

  const badge = STATUS_BADGE[file.status]
  const title = file.status === 'renamed' && file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path

  const renderComments = (list: ReviewComment[] | undefined) =>
    list?.map((c) =>
      editingId === c.id ? (
        <CommentEditor
          key={c.id}
          value={editText}
          onChange={setEditText}
          onSave={saveEdit}
          onCancel={() => {
            setEditingId(null)
            setEditText('')
          }}
          label="Edit comment"
          testIdPrefix="diff-comment-edit"
        />
      ) : (
        <div
          key={c.id}
          data-testid={`diff-comment-${c.id}`}
          className="border-y border-line bg-bg-elev px-3 py-2 font-sans text-[12px] text-fg"
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] text-fg-faint">
            <span>
              {c.side === 'old' ? 'old ' : ''}
              {c.startLine === c.endLine ? `line ${c.endLine}` : `lines ${c.startLine}-${c.endLine}`}
            </span>
            {!readOnly && (
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  data-testid={`diff-comment-edit-${c.id}`}
                  onClick={() => {
                    setEditingId(c.id)
                    setEditText(c.body)
                  }}
                  className="hover:text-fg"
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-testid={`diff-comment-delete-${c.id}`}
                  onClick={() => onRemoveComment(c.id)}
                  className="hover:text-accent"
                >
                  Delete
                </button>
              </span>
            )}
          </div>
          <div className="whitespace-pre-wrap">{c.body}</div>
        </div>
      ),
    )

  let body: ReactNode = null
  if (!collapsed) {
    if (file.binary) {
      body = (
        <div data-testid="diff-file-notice" className="px-3 py-2 text-[12px] text-fg-faint">
          Binary file, no preview
        </div>
      )
    } else if (file.tooLarge) {
      body = (
        <div data-testid="diff-file-notice" className="px-3 py-2 text-[12px] text-fg-faint">
          File diff too large to display — all {file.additions + file.deletions} changed lines are hidden
        </div>
      )
    } else {
      body = (
        <div className="overflow-x-auto font-mono text-[12px] leading-5">
          {file.hunks.map((hunk, hi) => (
            <Fragment key={hi}>
              <div
                data-testid="diff-hunk-header"
                className="border-y border-line bg-bg-elev px-3 py-0.5 text-fg-faint"
              >
                {hunk.header}
              </div>
              {hunk.lines.map((line, li) => {
                const anchor = rowAnchor(line)
                const rowKey = anchor ? `${anchor.side}:${anchor.line}` : null
                const inRange =
                  editor != null &&
                  anchor != null &&
                  editor.hunk === hi &&
                  editor.side === anchor.side &&
                  anchor.line >= editor.startLine &&
                  anchor.line <= editor.endLine
                const editorHere =
                  editor != null && anchor != null && editor.hunk === hi && editor.side === anchor.side && editor.endLine === anchor.line
                return (
                  <Fragment key={li}>
                    <div
                      data-testid="diff-line"
                      data-kind={line.kind}
                      className={`group flex ${ROW_TONE[line.kind]} ${inRange ? 'ring-1 ring-inset ring-accent' : ''}`}
                    >
                      <span data-testid="diff-old-no" className="w-12 shrink-0 select-none pr-2 text-right text-fg-faint">
                        {line.oldNo ?? ''}
                      </span>
                      <span data-testid="diff-new-no" className="w-12 shrink-0 select-none pr-2 text-right text-fg-faint">
                        {line.newNo ?? ''}
                      </span>
                      <span className="w-5 shrink-0 select-none text-center">
                        {!readOnly && anchor && (
                          <button
                            type="button"
                            data-testid={`diff-line-comment-${anchor.side}-${anchor.line}`}
                            aria-label={`Comment on ${anchor.side} line ${anchor.line}`}
                            onClick={(e) => onPlus(e, hi, anchor.side, anchor.line)}
                            className="rounded bg-accent px-1 leading-4 text-white opacity-0 focus:opacity-100 group-hover:opacity-100"
                          >
                            +
                          </button>
                        )}
                      </span>
                      <span className="w-4 shrink-0 select-none text-fg-dim">{MARKER[line.kind]}</span>
                      <span className="whitespace-pre pr-3 text-fg">{line.text}</span>
                    </div>
                    {rowKey && renderComments(commentsByRow.get(rowKey))}
                    {editorHere && editor && (
                      <CommentEditor
                        value={draft}
                        onChange={setDraft}
                        onSave={saveNew}
                        onCancel={closeEditor}
                        label={`${editor.side === 'old' ? 'old ' : ''}${
                          editor.startLine === editor.endLine
                            ? `line ${editor.endLine}`
                            : `lines ${editor.startLine}-${editor.endLine}`
                        } — shift-click another + to extend`}
                        testIdPrefix="diff-comment"
                      />
                    )}
                  </Fragment>
                )
              })}
            </Fragment>
          ))}
          {file.truncated && (
            <div data-testid="diff-file-notice" className="px-3 py-2 font-sans text-[12px] text-fg-faint">
              Diff truncated — the remaining lines of this file are hidden
            </div>
          )}
        </div>
      )
    }
  }

  return (
    <div data-testid="diff-file" className="rounded border border-line bg-bg-hi">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <button
          type="button"
          data-testid="diff-file-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand file' : 'Collapse file'}
          onClick={() => setCollapsed((v) => !v)}
          className="w-4 text-fg-dim hover:text-fg"
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span data-testid="diff-file-path" className="truncate font-mono text-fg">
          {title}
        </span>
        <span data-testid="diff-file-status" className={`rounded px-1.5 text-[11px] ${badge.cls}`}>
          {badge.label}
        </span>
        <span className="ml-auto font-mono">
          <span className="text-sage-dark">+{file.additions}</span>{' '}
          <span className="text-accent-dark">-{file.deletions}</span>
        </span>
      </div>
      {body}
    </div>
  )
}
