import { memo } from 'react'
import type { MemoryRow } from './model'

interface Props {
  row: MemoryRow | null
  known: ReadonlySet<string>
  onOpen: (slug: string) => void
  onRemoveLink: (slug: string) => void
  onAskAbout: () => void
}

const LABEL = 'text-[10px] tracking-[.08em] font-semibold text-fg-dim'
const CARD =
  'flex flex-col gap-px px-2 py-[6px] rounded-[5px] cursor-pointer bg-bg border text-left hover:border-fg-faint'

function LinkCard({
  testid, slug, sub, dangling, onClick,
}: { testid: string; slug: string; sub: string; dangling: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className={`${CARD} ${dangling ? 'border-accent-muted' : 'border-rule-structural'}`}
    >
      <span
        className={`text-[12px] font-medium overflow-hidden text-ellipsis whitespace-nowrap ${dangling ? 'text-accent' : ''}`}
      >
        {slug}
      </span>
      <span className={`text-[10.5px] ${dangling ? 'text-accent' : 'text-fg-dim'}`}>{sub}</span>
    </button>
  )
}

export const LinksRail = memo(function LinksRail({ row, onOpen, onRemoveLink, onAskAbout }: Props) {
  return (
    <aside
      data-testid="mx-links"
      className="bg-bg-elev border-l border-rule-structural px-[14px] py-4 flex flex-col gap-[18px] overflow-auto"
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
          <button
            type="button"
            data-testid="mx-links-ask"
            onClick={onAskAbout}
            className="mt-auto flex flex-col gap-[6px] p-[10px] border border-dashed border-rule rounded-[6px] cursor-pointer text-left hover:border-fg"
          >
            <span className="text-[12px] text-fg">Ask about this memory</span>
            <span className="h-7 border border-rule-structural rounded-[5px] bg-bg-hi px-2 flex items-center text-[11.5px] text-fg-dim">
              Is this still accurate?
            </span>
          </button>
        </>
      )}
    </aside>
  )
})
