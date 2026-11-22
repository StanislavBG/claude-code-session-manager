import { memo, useMemo, useState, type ReactNode } from 'react'
import { Z } from '../../../../lib/zLayers'
import { renderChatMarkdown } from '../../../../lib/renderChatMarkdown'
import type { MemoryRow } from './model'
import { MemorySuggestionCard, type Suggestion } from './MemorySuggestionCard'

interface Props {
  row: MemoryRow
  content: string | null
  clusterName: string
  clusterDot: string
  archived: boolean
  /** Edit mode: the header stays, the body is `editor` (the shared document editor). */
  editing?: boolean
  editor?: ReactNode
  onRead: () => void
  onEdit: () => void
  onCopyPath: () => void
  onReveal: () => void
  onArchive: () => void
  onRestore: () => void
  onAskDelete: () => void
  fix: Suggestion & { state: 'idle' | 'checking' | 'proposed' }
  /** The editor was opened from Claude's update (Edit first), not from the file. */
  editingSuggestion?: boolean
  appliedStill?: boolean
  onFix: () => void
  onApplyFix: () => void
  onEditFirst: () => void
  onDiscardFix: () => void
  onVerify: () => void
}

const BTN = 'text-xs font-medium h-[26px] px-2.5 border border-rule-structural rounded-[5px] bg-bg text-fg hover:border-fg'
const SEG = 'h-[30px] px-3 text-[13px] font-medium rounded-[7px]'
const MENU_ITEM = 'px-2.5 py-[7px] rounded-[5px] text-left text-[12.5px] hover:bg-bg-elev'

// Body typography; scoped to descendants so no global CSS is needed.
const PROSE =
  'max-w-[640px] text-sm leading-[1.65] text-fg flex flex-col gap-3 ' +
  '[&_p]:m-0 [&_h4]:mt-1.5 [&_h4]:mb-0 [&_h4]:text-[11px] [&_h4]:tracking-[.08em] [&_h4]:font-semibold [&_h4]:text-accent ' +
  '[&_code]:font-mono [&_code]:text-[12.5px] [&_code]:bg-bg-elev [&_code]:px-1 [&_code]:rounded-[3px] ' +
  '[&_ul]:m-0 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:m-0 [&_ol]:pl-5 [&_ol]:list-decimal'

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function formatAge(days: number): string {
  if (days <= 0) return 'just now'
  return `${days}d ago`
}

/** CLUSTER · TYPE · SIZE · MODIFIED <age> · SESSION <id> — only the facts the row actually has. */
export function eyebrowOf(row: MemoryRow, clusterName: string): string {
  const parts = [clusterName]
  if (row.type) parts.push(row.type)
  parts.push(formatSize(row.bytes), `modified ${formatAge(row.ageDays)}`)
  if (row.originSessionId) parts.push(`session ${row.originSessionId.slice(0, 8)}`)
  return parts.join(' · ').toUpperCase()
}

function stripFrontmatter(src: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(src)
  return (m ? src.slice(m[0].length) : src).trim()
}

// Turn the two memory labels into h4 headings before marked sees them.
function labelHeadings(md: string): string {
  return md
    .replace(/^\*\*Why:\*\*[ \t]*/gim, '#### WHY\n\n')
    .replace(/^\*\*How to apply:\*\*[ \t]*/gim, '#### HOW TO APPLY\n\n')
}

export const MemoryReader = memo(function MemoryReader(p: Props) {
  const { row, fix } = p
  const [menu, setMenu] = useState(false)

  const html = useMemo(() => {
    if (p.content === null || p.editing) return ''
    return renderChatMarkdown(labelHeadings(stripFrontmatter(p.content)))
  }, [p.content, p.editing])

  const pick = (fn: () => void) => () => { setMenu(false); fn() }

  return (
    <div data-testid="mx-reader" className="flex flex-col flex-1 min-w-0 min-h-0">
      <div data-testid="mx-reader-header" className="shrink-0 px-9 pt-6 pb-5 border-b border-rule-structural flex items-end gap-3">
        <div className="flex-1 min-w-0">
          <div data-testid="mx-reader-eyebrow" className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.1em] text-fg-faint">
            <span className={`w-[7px] h-[7px] rounded-sm shrink-0 ${p.clusterDot}`} />
            <span className="truncate">{eyebrowOf(row, p.clusterName)}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2.5 min-w-0">
            <span data-testid="mx-reader-title" className="min-w-0 [overflow-wrap:anywhere] font-mono text-[27px] font-semibold tracking-[-0.015em] text-fg">
              {row.slug}
            </span>
            {p.editing ? (
              <span data-testid="mx-reader-pill" className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-butter/50 text-honey-dark">
                {p.editingSuggestion ? "Editing Claude's update" : 'Editing'}
              </span>
            ) : !p.archived && fix.state === 'proposed' ? (
              <span data-testid="mx-reader-pill" className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-butter/50 text-honey-dark">
                Suggestion ready
              </span>
            ) : null}
          </div>
        </div>
        {!p.archived && (
          <div className="shrink-0 flex items-center gap-2">
            <div role="group" aria-label="View" className="flex p-[3px] rounded-[10px] bg-bg-elev border border-rule-structural">
              <button
                type="button"
                data-testid="mx-reader-mode-read"
                aria-pressed={!p.editing}
                onClick={p.editing ? p.onRead : undefined}
                className={`${SEG} ${!p.editing ? 'bg-bg-hi text-fg shadow-sm' : 'text-fg-dim hover:text-fg'}`}
              >
                Read
              </button>
              <button
                type="button"
                data-testid="mx-reader-edit"
                aria-pressed={!!p.editing}
                disabled={p.content === null}
                onClick={p.editing ? undefined : p.onEdit}
                className={`${SEG} ${p.editing ? 'bg-bg-hi text-fg shadow-sm' : 'text-fg-dim hover:text-fg'} disabled:opacity-50`}
              >
                Edit
              </button>
            </div>
            {!p.editing && !row.stale && fix.state === 'idle' && (
              <button
                type="button"
                data-testid="mx-reader-fix"
                title="Uses Claude"
                onClick={p.onFix}
                className="h-[38px] px-4 rounded-[10px] bg-accent text-bg-hi hover:bg-accent/90 text-[13.5px] font-semibold"
              >
                + Review with Claude
              </button>
            )}
            <div className="relative">
              <button
                type="button"
                data-testid="mx-reader-more"
                aria-label="More actions"
                onClick={() => setMenu((v) => !v)}
                className="h-[38px] w-[38px] rounded-[10px] border border-rule-structural bg-bg-hi text-fg hover:border-fg"
              >
                ⋯
              </button>
              {menu && (
                <>
                  <div className={`fixed inset-0 ${Z.dialog}`} onClick={() => setMenu(false)} />
                  <div
                    className={`absolute right-0 top-11 w-[200px] ${Z.dialog} bg-bg-hi border border-rule-structural rounded-[7px] shadow-lg p-1 flex flex-col text-fg`}
                  >
                    <button type="button" className={MENU_ITEM} onClick={pick(p.onCopyPath)}>Copy path</button>
                    <button type="button" className={MENU_ITEM} onClick={pick(p.onReveal)}>Reveal in folder</button>
                    <div className="h-px bg-rule-inner mx-1.5 my-1" />
                    <button type="button" className={MENU_ITEM} onClick={pick(p.onArchive)}>Archive</button>
                    <button type="button" className={`${MENU_ITEM} text-accent`} onClick={pick(p.onAskDelete)}>Delete…</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {p.editing ? (
        <div data-testid="mx-reader-editor" className="flex-1 min-h-0 flex flex-col px-9 py-6">{p.editor}</div>
      ) : (
      <>
      {p.archived && (
        <div className="mx-9 mt-3 px-3 py-2.5 rounded-md bg-bg-elev flex items-center gap-2.5 text-[12.5px] text-fg-dim">
          <span className="flex-1">Archived — read-only. Claude no longer loads this memory.</span>
          <button type="button" data-testid="mx-reader-restore" onClick={p.onRestore} className={BTN}>Restore</button>
        </div>
      )}

      {!p.archived && row.stale && fix.state === 'idle' && (
        <div
          data-testid="mx-reader-stale"
          className="mx-9 mt-3 px-3 py-2.5 rounded-md bg-butter/40 text-honey-dark flex gap-2.5 items-center text-[12.5px]"
        >
          <div className="flex-1 flex flex-col gap-0.5">
            <b className="font-semibold">
              {p.appliedStill
                ? `Applied — still flagged: ${row.staleReasons[0] ?? 'needs review'}`
                : `Stale — ${row.staleReasons[0] ?? 'needs review'}`}
            </b>
            {row.deadRefs.length > 0 && (
              <span className="font-mono text-[11px]">{row.deadRefs.join(' · ')}</span>
            )}
          </div>
          <span className="text-[11px]">uses Claude</span>
          <button
            type="button"
            data-testid="mx-reader-fix"
            onClick={p.onFix}
            className="text-xs font-medium h-[26px] px-2.5 rounded-[5px] bg-fg text-bg"
          >
            Fix with assistant
          </button>
          {row.ageOnlyStale && (
            <button
              type="button"
              data-testid="mx-reader-verify"
              onClick={p.onVerify}
              className="text-xs font-medium h-[26px] px-2.5 rounded-[5px] border border-honey text-honey-dark"
            >
              Mark verified
            </button>
          )}
        </div>
      )}

      {!p.archived && fix.state === 'checking' && (
        <div className="mx-9 mt-3 p-3 rounded-md border border-dashed border-honey bg-butter/20 text-[12.5px] text-honey-dark flex items-center gap-2.5">
          <span className="font-mono text-accent">●○○</span>
          Assistant is checking {row.deadRefs.length > 0 ? `${row.deadRefs.length} references` : 'this memory'} against the repo…
        </div>
      )}

      {!p.archived && fix.state === 'proposed' && (
        <MemorySuggestionCard fix={fix} onApply={p.onApplyFix} onEditFirst={p.onEditFirst} onDiscard={p.onDiscardFix} />
      )}

      {row.broken && !row.stale && (
        <div className="mx-9 mt-3 px-3 py-2.5 rounded-md bg-accent-muted/30 text-[12.5px] text-accent-dark">
          Broken reference — a link or path in this memory points at nothing. See the red items in Links.
        </div>
      )}

      {row.notIndexed && (
        <div className="mx-9 mt-3 px-3 py-2.5 rounded-md bg-butter/40 text-[12.5px] text-honey-dark">
          Claude won't load this — it has no line in MEMORY.md.
        </div>
      )}

      <div className="flex-1 overflow-auto px-9 pt-6 pb-[22px]">
        {p.content === null ? (
          <div className="text-xs text-fg-faint">Loading…</div>
        ) : (
          <div className={PROSE}>
            {row.description && (
              <p className="font-serif text-[17px] leading-normal text-fg">{row.description}</p>
            )}
            <div className="contents" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
      </div>
      </>
      )}
    </div>
  )
})
