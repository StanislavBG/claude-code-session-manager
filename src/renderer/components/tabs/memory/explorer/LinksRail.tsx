import { memo } from 'react'
import type { MemoryRow } from './model'

interface Props {
  row: MemoryRow | null
  known: ReadonlySet<string>
  onOpen: (slug: string) => void
  onRemoveLink: (slug: string) => void
  onAskAbout: () => void
  onUpdatePath: (ref: { from: string; to: string }) => void
  onReviewPath: () => void
  /** ASK CLAUDE card's 'Check against the repo' — the existing check (review) action. */
  onCheck: () => void
  /** A check is already running or showing its result — the button waits. */
  checkBusy?: boolean
  /** The file is open in the editor: the Ask card gives way to an editing note. */
  editing?: boolean
}

const LABEL = 'text-[11px] tracking-[.1em] font-semibold text-fg-faint'
const CARD =
  'flex flex-col gap-0.5 px-3.5 py-2.5 rounded-[10px] cursor-pointer bg-bg-hi border text-left hover:border-fg-faint'

function LinkCard({
  testid, slug, sub, dangling, onClick,
}: { testid: string; slug: string; sub: string; dangling: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={`${CARD} ${dangling ? 'border-accent-muted' : 'border-rule-inner'}`}
    >
      <span
        className={`font-mono text-[12.5px] font-medium break-all ${dangling ? 'text-accent' : 'text-fg'}`}
      >
        {slug}
      </span>
      <span className={`text-[10.5px] ${dangling ? 'text-accent' : 'text-fg-dim'}`}>{sub}</span>
    </button>
  )
}

export const LinksRail = memo(function LinksRail({
  row, onOpen, onRemoveLink, onAskAbout, onUpdatePath, onReviewPath, onCheck, checkBusy, editing,
}: Props) {
  return (
    <aside
      data-testid="mx-links"
      className="px-5 py-6 flex flex-col gap-[18px] overflow-auto"
    >
      {row && (
        <>
          <div className="flex flex-col gap-[6px]">
            <span className={LABEL}>LINKS TO · {row.outLinks.length}</span>
            {row.outLinks.map((slug) => {
              const dangling = row.danglingLinks.includes(slug)
              return (
                <LinkCard
                  key={slug}
                  testid={`mx-link-out-${slug}`}
                  slug={slug}
                  dangling={dangling}
                  sub={dangling ? 'missing · click to remove link' : 'wikilink'}
                  onClick={() => (dangling ? onRemoveLink(slug) : onOpen(slug))}
                />
              )
            })}
            {row.outLinks.length === 0 && (
              <span className="text-[12px] text-fg-dim">No outgoing links.</span>
            )}
          </div>
          {row.movedRefs.length + row.deadRefs.length > 0 && (
            <div className="flex flex-col gap-[6px]">
              <span className={LABEL}>PATHS · {row.movedRefs.length + row.deadRefs.length}</span>
              {row.movedRefs.map((m, i) => (
                <LinkCard
                  key={`moved-${m.from}`}
                  testid={`mx-path-moved-${i}`}
                  slug={m.from}
                  dangling={false}
                  sub={`moved to ${m.to} · click to update`}
                  onClick={() => onUpdatePath({ from: m.from, to: m.to })}
                />
              ))}
              {row.deadRefs.map((p, i) => (
                <LinkCard
                  key={`dead-${p}`}
                  testid={`mx-path-dead-${i}`}
                  slug={p}
                  dangling
                  sub="not found anywhere · review with assistant"
                  onClick={onReviewPath}
                />
              ))}
            </div>
          )}
          <div className="flex flex-col gap-[6px]">
            <span className={LABEL}>LINKED FROM · {row.inLinks.length}</span>
            {row.inLinks.map((slug) => (
              <LinkCard
                key={slug}
                testid={`mx-link-in-${slug}`}
                slug={slug}
                dangling={false}
                sub="wikilink"
                onClick={() => onOpen(slug)}
              />
            ))}
            {row.inLinks.length === 0 && (
              <span className="text-[12px] text-fg-dim">Nothing links here yet.</span>
            )}
          </div>
          {editing ? (
            <div
              data-testid="mx-links-editing"
              className="flex flex-col gap-1.5 px-4 py-3.5 rounded-[14px] border border-dashed border-rule-structural text-[12px] leading-normal text-fg-dim"
            >
              <span className={LABEL}>EDITING THE FILE ON DISK</span>
              <span>
                Keep the frontmatter lines (name, description, type). Save writes{' '}
                <span className="font-mono break-all">{row.name}</span>.
              </span>
            </div>
          ) : (
            <div
              data-testid="mx-links-askclaude"
              className="flex flex-col gap-2 px-4 py-3.5 rounded-[14px] border border-honey/50 bg-butter/30"
            >
              <span className={`${LABEL} !text-honey-dark`}>ASK CLAUDE</span>
              <span className="font-serif text-[17px] leading-snug text-fg">Is this memory still accurate?</span>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  data-testid="mx-links-check"
                  disabled={checkBusy}
                  onClick={onCheck}
                  className="h-8 px-3 rounded-[8px] bg-accent text-bg-hi hover:bg-accent/90 text-[13px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Check against the repo
                </button>
                <button
                  type="button"
                  data-testid="mx-links-ask"
                  onClick={onAskAbout}
                  className="text-[12px] text-honey-dark hover:text-fg"
                >
                  Ask a question…
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  )
})
