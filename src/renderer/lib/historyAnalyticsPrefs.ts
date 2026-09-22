/**
 * The History screen's `history` sub-object in `~/.claude/session-manager/ui-settings-prefs.json`
 * — measure/range (HistoryDashboard.tsx) and budgetCapUsd (BudgetStrip.tsx) are two
 * independent writers sharing one nested object, so a plain
 * `writeUiSettingsPrefs({ history: patch })` call would replace the whole `history`
 * value and drop whichever sibling field the other writer last saved.
 * `writeHistoryAnalyticsPrefs` re-reads the current `history` value and serializes
 * every write through its own queue (mirrors `uiSettingsPrefs.ts`'s top-level
 * read-modify-write, one level down) so the two writers' patches always merge.
 */
import { readUiSettingsPrefs, writeUiSettingsPrefs } from './uiSettingsPrefs'

export interface HistoryAnalyticsPrefs {
  measure?: string
  range?: number
  budgetCapUsd?: number
}

export async function readHistoryAnalyticsPrefs(): Promise<HistoryAnalyticsPrefs> {
  const prefs = await readUiSettingsPrefs()
  return prefs.history ?? {}
}

let writeQueue: Promise<void> = Promise.resolve()

export function writeHistoryAnalyticsPrefs(patch: HistoryAnalyticsPrefs): Promise<void> {
  const run = writeQueue.then(async () => {
    const current = await readHistoryAnalyticsPrefs()
    await writeUiSettingsPrefs({ history: { ...current, ...patch } })
  })
  // Chain the queue through a swallowed copy so one write's rejection never
  // stalls the next caller's turn; `run` itself still rejects for its own caller.
  writeQueue = run.catch(() => {})
  return run
}
