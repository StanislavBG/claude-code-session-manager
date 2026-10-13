import { memo, useMemo, useState } from 'react'
import { Z } from '../../../../lib/zLayers'
import { renderChatMarkdown } from '../../../../lib/renderChatMarkdown'
import type { MemoryRow } from './model'

interface DiffLine { sign: '−' | '+' | ' '; text: string }

interface Props {
  row: MemoryRow
  content: string | null
  clusterName: string
  clusterDot: string
  archived: boolean
  mode: 'read' | 'source'
  onMode: (m: 'read' | 'source') => void
  onEdit: () => void
  onCopyPath: () => void
  onReveal: () => void
  onArchive: () => void
  onRestore: () => void
  onAskDelete: () => void
  fix: { state: 'idle' | 'checking' | 'proposed'; diff: DiffLine[]; summary: string }
  onFix: () => void
  onApplyFix: () => void
  onDiscardFix: () => void
  onVerify: () => void
}

const BTN = 'text-xs font-medium h-[26px] px-2.5 border border-rule-structural rounded-[5px] bg-bg text-fg hover:border-fg'
const CHIP = 'px-[7px] py-0.5 rounded bg-bg-elev'
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
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
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
    if (p.content === null || p.mode !== 'read') return ''
    return renderChatMarkdown(labelHeadings(stripFrontmatter(p.content)))
  }, [p.content, p.mode])

  const pick = (fn: () => void) => () => { setMenu(false); fn() }

  return (
    <div data-testid="mx-reader" className="flex flex-col flex-1 min-w-0 min-h-0">
      <div className="px-[22px] pt-3.5 pb-3 border-b border-rule-structural flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs text-fg-dim">
          <span className={`w-[7px] h-[7px] rounded-sm ${p.clusterDot}`} />
          <span>{p.clusterName}</span>
          <span className="flex-1" />
          {!p.archived && (
            <>
              <div className="flex border border-rule-structural rounded-[5px] overflow-hidden">
                <button
                  type="button"
                  data-testid="mx-reader-mode-read"
                  onClick={() => p.onMode('read')}
                  className={`px-2.5 py-[3px] text-fg ${p.mode === 'read' ? 'bg-muteband' : ''}`}
                >
                  Read
                </button>
                <button
                  type="button"
                  data-testid="mx-reader-mode-source"
                  onClick={() => p.onMode('source')}
                  className={`px-2.5 py-[3px] text-fg border-l border-rule-structural ${p.mode === 'source' ? 'bg-muteband' : ''}`}
                >
                  Source
                </button>
              </div>
              <button type="button" data-testid="mx-reader-edit" onClick={p.onEdit} className={BTN}>Edit</button>
              <div className="relative">
                <button
                  type="button"
                  data-testid="mx-reader-more"
                  onClick={() => setMenu((v) => !v)}
                  className={`${BTN} !px-2`}
                >
                  ⋯
                </button>
                {menu && (
                  <>
                    <div className={`fixed inset-0 ${Z.dialog}`} onClick={() => setMenu(false)} />
                    <div
                      className={`absolute right-0 top-8 w-[200px] ${Z.dialog} bg-bg-hi border border-rule-structural rounded-[7px] shadow-lg p-1 flex flex-col text-fg`}
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
            </>
          )}
        </div>
        <div className="font-mono text-[18px] font-medium text-fg break-all">{row.slug}</div>
        <div className="flex flex-wrap gap-1.5 text-[11.5px] text-fg-dim">
          {row.type && <span className={CHIP}>type · {row.type}</span>}
          <span className={CHIP}>{formatSize(row.bytes)}</span>
          <span className={CHIP}>modified {formatAge(row.ageDays)}</span>
          {row.originSessionId && (
            <span className={`${CHIP} font-mono text-[10.5px]`}>session {row.originSessionId.slice(0, 8)}</span>
          )}
        </div>
      </div>

      {p.archived && (
        <div className="mx-[22px] mt-3 px-3 py-2.5 rounded-md bg-bg-elev flex items-center gap-2.5 text-[12.5px] text-fg-dim">
          <span className="flex-1">Archived — read-only. Claude no longer loads this memory.</span>
          <button type="button" data-testid="mx-reader-restore" onClick={p.onRestore} className={BTN}>Restore</button>
        </div>
      )}

      {!p.archived && row.stale && fix.state === 'idle' && (
        <div
          data-testid="mx-reader-stale"
          className="mx-[22px] mt-3 px-3 py-2.5 rounded-md bg-butter/40 text-honey-dark flex gap-2.5 items-center text-[12.5px]"
        >
          <div className="flex-1 flex flex-col gap-0.5">
            <b className="font-semibold">Stale — {row.staleReasons[0] ?? 'needs review'}</b>
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

      {!p.archived && row.stale && fix.state === 'checking' && (
        <div className="mx-[22px] mt-3 p-3 rounded-md border border-dashed border-honey bg-butter/20 text-[12.5px] text-honey-dark flex items-center gap-2.5">
          <span className="font-mono text-accent">●○○</span>
          Assistant is checking {row.deadRefs.length > 0 ? `${row.deadRefs.length} references` : 'this memory'} against the repo…
        </div>
      )}

      {!p.archived && row.stale && fix.state === 'proposed' && (
        <div className="mx-[22px] mt-3 border border-honey rounded-md overflow-hidden bg-bg-hi">
          <div className="px-3 py-[9px] bg-butter/40 text-[12.5px] text-honey-dark font-semibold">Suggested update</div>
          {fix.diff.map((d, i) => (
            <div
              key={i}
              className={`grid grid-cols-[20px_1fr] px-3 py-1.5 font-mono text-xs leading-normal border-t border-rule-inner ${
                d.sign === '−' ? 'bg-accent/10 text-accent-dark' : d.sign === '+' ? 'bg-sage/15 text-sage-dark' : 'text-fg-dim'
              }`}
            >
              <span>{d.sign}</span>
              <span className="whitespace-pre-wrap break-words">{d.text}</span>
            </div>
          ))}
          <div className="flex gap-2 px-3 py-2.5 border-t border-rule-structural items-center">
            <button
              type="button"
              data-testid="mx-reader-apply"
              onClick={p.onApplyFix}
              className="text-xs font-medium h-7 px-3 rounded-[5px] bg-fg text-bg"
            >
              Apply
            </button>
            <button
              type="button"
              data-testid="mx-reader-discard"
              onClick={p.onDiscardFix}
              className="text-xs font-medium h-7 px-3 rounded-[5px] border border-rule text-fg"
            >
              Discard
            </button>
            <span className="flex-1" />
            <span className="text-[11.5px] text-fg-dim">Writes the file, clears stale</span>
          </div>
        </div>
      )}

      {row.broken && !row.stale && (
        <div className="mx-[22px] mt-3 px-3 py-2.5 rounded-md bg-accent/10 text-[12.5px] text-accent-dark">
          Broken reference — a link or path in this memory points at nothing. See the red items in Links.
        </div>
      )}

      {row.notIndexed && (
        <div className="mx-[22px] mt-3 px-3 py-2.5 rounded-md bg-butter/40 text-[12.5px] text-honey-dark">
          Claude won't load this — it has no line in MEMORY.md.
        </div>
      )}

      <div className="flex-1 overflow-auto px-[22px] pt-4 pb-[22px]">
        {p.content === null ? (
          <div className="text-xs text-fg-faint">Loading…</div>
        ) : p.mode === 'source' ? (
          <pre className="m-0 px-4 py-3.5 bg-fg text-bg-elev rounded-md font-mono text-xs leading-[1.7] whitespace-pre-wrap">
            {p.content}
          </pre>
        ) : (
          <div className={PROSE}>
            {row.description && (
              <p className="font-serif text-[17px] leading-normal text-fg">{row.description}</p>
            )}
            <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
      </div>

      <div className="px-[22px] py-2 border-t border-rule-structural font-mono text-[10.5px] text-fg-dim whitespace-nowrap overflow-hidden text-ellipsis">
        {row.path}
      </div>
    </div>
  )
})
