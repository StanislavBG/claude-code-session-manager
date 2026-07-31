import { create } from 'zustand'

export type EpicUsage = { inputTokens: number; outputTokens: number }

/**
 * Token-usage totals per Epic, fetched in batches from
 * `window.api.transcripts.usageFor(cwd, sessionIds)` — one call per distinct
 * cwd among the visible Epics, never per row. Keyed by Epic id (not
 * claudeSessionId) so it joins directly into EpicSnapshots alongside
 * sessions/chats/jobs/prds. An Epic whose transcript hasn't produced a usage
 * event yet (or errored) is omitted from the map rather than stored as null,
 * so callers' `usage[epicId]` reads are a plain presence check.
 */
interface EpicUsageState {
  usage: Record<string, EpicUsage>
  fetch: (epics: ReadonlyArray<{ id: string; cwd: string; claudeSessionId: string }>) => Promise<void>
}

export const useEpicUsage = create<EpicUsageState>((set, get) => ({
  usage: {},

  fetch: async (epics) => {
    if (epics.length === 0) return
    const byCwd = new Map<string, { id: string; claudeSessionId: string }[]>()
    for (const e of epics) {
      const list = byCwd.get(e.cwd) ?? []
      list.push({ id: e.id, claudeSessionId: e.claudeSessionId })
      byCwd.set(e.cwd, list)
    }

    const results = await Promise.all(
      Array.from(byCwd.entries()).map(async ([cwd, rows]) => {
        try {
          const res = await window.api.transcripts.usageFor(cwd, rows.map((r) => r.claudeSessionId))
          return { rows, res }
        } catch {
          return { rows, res: {} as Record<string, EpicUsage | null> }
        }
      }),
    )

    const next = { ...get().usage }
    for (const { rows, res } of results) {
      for (const row of rows) {
        const u = res[row.claudeSessionId]
        if (u) next[row.id] = u
        else delete next[row.id]
      }
    }
    set({ usage: next })
  },
}))
