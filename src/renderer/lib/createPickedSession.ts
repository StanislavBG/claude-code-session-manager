/**
 * Pick a directory via the OS dialog and open a Claude session there.
 *
 * The "pick a folder + spawn `claude --dangerously-skip-permissions
 * --session-id <uuid>`" flow used to live inline in three places: App.tsx
 * (menu + Ctrl+N), TabBar.tsx (the + button), and Overview.tsx's
 * QuickActions. Each spelt the same flow slightly differently. Unified here.
 *
 * Returns the new tab id on success, or null if the user cancelled the picker.
 * Throws on IPC / spawn failures — callers should toast.
 */
import { useSessions } from '../state/sessions'
import { shellQuote } from './presets'

export async function createPickedSession(): Promise<string | null> {
  const cwd = await window.api.app.pickDirectory()
  if (!cwd) return null
  const id = crypto.randomUUID()
  const startupCommand = `claude --dangerously-skip-permissions --session-id ${shellQuote(id)}`
  useSessions.getState().addTab({ id, cwd, startupCommand, presetId: 'pick-dangerous' })
  return id
}
