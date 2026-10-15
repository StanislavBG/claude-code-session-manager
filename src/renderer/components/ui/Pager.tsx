interface Props {
  /** 1-based current page. */
  page: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
  /** Prefix for the root/prev/range/next testids. Default `plan-pager`. */
  testIdPrefix?: string
  /** Tighter padding for use inside a card. */
  compact?: boolean
}

/** Prev/Next pager with a `<first>–<last> of <total>` range label. Renders nothing when
 *  everything fits on one page. */
export function Pager({ page, pageSize, totalItems, onPageChange, testIdPrefix = 'plan-pager', compact = false }: Props) {
  if (totalItems <= pageSize) return null
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const first = (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, totalItems)
  const rootCls = compact
    ? 'flex items-center justify-center gap-3 px-2 py-1.5 font-mono text-[11px] text-fg-faint'
    : 'flex items-center justify-center gap-3 px-[18px] py-3 font-mono text-[12px] text-fg-faint'
  return (
    <div data-testid={testIdPrefix} className={rootCls}>
      <button
        type="button"
        data-testid={`${testIdPrefix}-prev`}
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="px-2 py-1 rounded border border-line bg-bg-hi text-fg-dim hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        Prev
      </button>
      <span data-testid={`${testIdPrefix}-range`}>{first}–{last} of {totalItems}</span>
      <button
        type="button"
        data-testid={`${testIdPrefix}-next`}
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="px-2 py-1 rounded border border-line bg-bg-hi text-fg-dim hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        Next
      </button>
    </div>
  )
}
