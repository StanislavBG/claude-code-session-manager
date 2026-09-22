/**
 * Per-project UI state — `<cwd>/session-manager-operations/ui-prefs/prefs.json`.
 * Single-writer namespace `ui-prefs` (`src/main/lib/opsOwnership.cjs`'s OWNERS).
 * Mirrors `uiSettingsPrefs.ts`'s shared-file pattern (read-modify-write, writes
 * serialized so independent field-owners can't interleave and drop each
 * other's change) but keyed PER CWD instead of one machine-wide file — each
 * project gets its own file and therefore its own write queue, so two
 * projects can never collide on the same field the way a single global
 * `localStorage` key used to (PRD 1398: `sm.scheduler.hiddenCompletedSlugs`
 * hid one project's completed rows because another project happened to reuse
 * the same PRD slug).
 */
export interface UiPrefs {
  /** FileTree.tsx — expanded folder paths in the Files sidebar. */
  fileTreeExpanded?: string[]
  /** SchedulePanel.tsx — "Clear completed" hides (renderer-side only; queue.json is unchanged). */
  hiddenCompletedSlugs?: string[]
  /** SchedulePanel.tsx — the queue's status filter chip. */
  queueFilterStatus?: string
}

export function uiPrefsPath(cwd: string): string {
  return `${cwd.replace(/\/+$/, '')}/session-manager-operations/ui-prefs/prefs.json`
}

export async function readUiPrefs(cwd: string): Promise<UiPrefs> {
  if (!cwd || typeof window === 'undefined' || !window.api?.config?.readJson) return {}
  try {
    const r = await window.api.config.readJson(uiPrefsPath(cwd))
    if (r?.exists && r.data && typeof r.data === 'object') return r.data as UiPrefs
  } catch { /* diagnostic surface only */ }
  return {}
}

// Serializes writes PER CWD (not one shared queue) so unrelated projects
// never wait on each other, while independent field-owners writing the SAME
// project's file (FileTree's fileTreeExpanded, SchedulePanel's
// hiddenCompletedSlugs/queueFilterStatus) still can't race: an overlapping
// write's own read could otherwise complete before an earlier write's read
// lands its file update, and `{ ...current, ...patch }` would spread a
// now-stale `current`, silently dropping the other field's change.
const writeQueues = new Map<string, Promise<void>>()

export function writeUiPrefsPatch(cwd: string, patch: UiPrefs): Promise<void> {
  if (!cwd) return Promise.resolve()
  const prev = writeQueues.get(cwd) ?? Promise.resolve()
  const run = prev.then(async () => {
    if (typeof window === 'undefined' || !window.api?.config?.writeJson) return
    const current = await readUiPrefs(cwd)
    await window.api.config.writeJson(uiPrefsPath(cwd), { ...current, ...patch }, 'ui-prefs')
  })
  // Chain the queue through a swallowed copy so one write's rejection never
  // stalls the next caller's turn; `run` itself still rejects for its own caller.
  writeQueues.set(cwd, run.catch(() => {}))
  return run
}
