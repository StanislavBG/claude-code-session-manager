import type { MemoryEntry, MemoryStaleEntry } from '../../preload/api'

export function filterEntries(
  entries: MemoryEntry[],
  filter: string,
  staleOnly: boolean,
  staleByName: Record<string, MemoryStaleEntry>,
): MemoryEntry[] {
  return entries
    .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((e) => !staleOnly || staleByName[e.name]?.stale === true)
}
