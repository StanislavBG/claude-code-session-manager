/**
 * Pick a directory via the OS dialog and open a dormant Chat-view tab there.
 *
 * The "pick a folder + open a tab" flow used to live inline in three places:
 * App.tsx (menu + Ctrl+N), TabBar.tsx (the + button), and Overview.tsx's
 * QuickActions. Each spelt the same flow slightly differently. Unified here.
 *
 * No process is spawned — the tab is added in `dormant` state and only
 * starts a PTY when the user later wakes it.
 *
 * Returns the new tab id on success, or null if the user cancelled the picker.
 * Throws only if the `pickDirectory` IPC call itself fails — callers should toast.
 */
import { useSessions } from '../state/sessions'
import type { CreateProjectFolderResult } from '../../preload/api'

export async function createPickedSession(): Promise<string | null> {
  const cwd = await window.api.app.pickDirectory()
  if (!cwd) return null
  const id = crypto.randomUUID()
  useSessions.getState().addTab({ id, cwd, startupCommand: null, presetId: 'pick-dangerous', dormant: true })
  return id
}

/**
 * Open `cwd` as the project's TAB: activate the existing tab for that folder,
 * else add a dormant one. Shared by the picker and the New Project path.
 */
export function openProjectAt(cwd: string): string {
  const s = useSessions.getState()
  const existing = s.tabs.find((t) => t.cwd === cwd)
  if (existing) {
    s.setActive(existing.id)
    return existing.id
  }
  const id = crypto.randomUUID()
  s.addTab({ id, cwd, startupCommand: null, presetId: 'pick-dangerous', dormant: true })
  return id
}

/**
 * "Open / Start Project" (2026-07-31 domain model): TAB = project folder,
 * exactly one tab per project — work inside a project is managed via Epics,
 * not extra tabs. Browse to an existing folder to OPEN it (the native picker's
 * New Folder button is macOS-only, so START goes through `startNewProject`).
 * If a tab already exists for the chosen folder it is activated, not
 * duplicated.
 *
 * Returns the (new or existing) tab id, or null if the picker was cancelled.
 */
export async function openOrStartProject(): Promise<string | null> {
  const cwd = await window.api.app.pickDirectory()
  if (!cwd) return null
  return openProjectAt(cwd)
}

/**
 * START a project: create `<parentDir>/<name>` via main, then open it as the
 * project TAB. On failure the result is returned unchanged and no tab is added.
 */
export async function startNewProject(
  parentDir: string,
  name: string,
): Promise<CreateProjectFolderResult & { tabId?: string }> {
  const result = await window.api.app.createProjectFolder(parentDir, name)
  if (!result.ok) return result
  return { ...result, tabId: openProjectAt(result.path) }
}
