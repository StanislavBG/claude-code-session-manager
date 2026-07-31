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

export async function createPickedSession(): Promise<string | null> {
  const cwd = await window.api.app.pickDirectory()
  if (!cwd) return null
  const id = crypto.randomUUID()
  useSessions.getState().addTab({ id, cwd, startupCommand: null, presetId: 'pick-dangerous', dormant: true })
  return id
}
