import { useMemo, useState } from 'react'

/** Slice `items` into 1-based pages of `pageSize`. `page` is clamped (derived) to the last
 *  valid page when the list shrinks, so callers never render an out-of-range page. */
export function usePagedList<T>(items: readonly T[], pageSize: number) {
  const [rawPage, setPage] = useState(1)
  const total = items.length
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, rawPage), lastPage)
  const pageItems = useMemo(
    () => items.slice((page - 1) * pageSize, page * pageSize),
    [items, page, pageSize],
  )
  return { page, setPage, pageItems, pageSize, total }
}
