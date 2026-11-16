import { useEffect } from 'react'
import { useToast } from '../state/toast'
import { usePromptSessions, type PromptSessionEvent } from '../state/promptSessions'
import { splitTitleAndGoal } from './epicDerive'

/**
 * App-wide toast for a cross-project reply landing in an Epic.
 *
 * Main appends a 'cross-project-reply' notice event to the asking Epic (open,
 * idle or closed, any project) when another project answers it. This hook —
 * mounted once in App.tsx — surfaces that as one info toast so the human
 * learns of it whatever page they are on.
 *
 * Reads the Epic title via getState() inside the handler (no cross-store
 * subscription). Dedupes by event.id across remounts with a bounded
 * module-level set.
 */

const MAX_SEEN = 500
const seen = new Set<string>()

function remember(id: string): boolean {
  if (seen.has(id)) return false
  seen.add(id)
  if (seen.size > MAX_SEEN) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

function basename(p: string): string {
  const t = p.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  return i < 0 ? t : t.slice(i + 1)
}

export function useCrossProjectReplyToast(): void {
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api?.promptSessions : undefined
    if (typeof api?.onEventAppended !== 'function') return
    const off = api.onEventAppended(({ promptSessionId, event }) => {
      // The preload payload type predates the reply notice; the store's
      // PromptSessionEvent carries `notice: 'cross-project-reply'` + `reply`.
      const ev = event as unknown as PromptSessionEvent
      if (ev?.notice !== 'cross-project-reply') return
      if (!ev.id || !remember(ev.id)) return
      const epicId = promptSessionId || ev.promptSessionId
      const session = usePromptSessions.getState().sessions[epicId]
      const title = session?.goalText ? splitTitleAndGoal(session.goalText).title.trim() : ''
      const from = ev.reply?.fromCwd ? basename(ev.reply.fromCwd) : 'another project'
      useToast.getState().show('info', `Reply from ${from} landed in ${title || epicId}`)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])
}

/** Test-only — clears the dedupe set. */
export function _resetCrossProjectReplyToastForTests(): void {
  seen.clear()
}
