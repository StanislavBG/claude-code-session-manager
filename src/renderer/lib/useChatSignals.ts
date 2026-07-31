import { useEffect, useState } from 'react'
import { useChat, type TabChat } from '../state/chat'

/**
 * Signal-level signature of the chats record: everything the Epics queue's
 * derive helpers (epicDisplayStatus/epicStats) actually read — running flag,
 * queue position, needs-input, turn count, tool-call count — and nothing
 * token-level (`stream` grows on every delta and is deliberately excluded).
 */
function signatureOf(chats: Record<string, TabChat>): string {
  const parts: string[] = []
  for (const id of Object.keys(chats)) {
    const c = chats[id]
    let needs = 0
    for (const t of c.ticketHistory ?? []) if (t.status === 'needs-input') needs = 1
    let tools = 0
    for (const t of c.turns) tools += t.toolUses?.length ?? 0
    parts.push(`${id}:${c.running ? 1 : 0}:${c.queuedPosition ?? 0}:${c.turns.length}:${tools}:${needs}`)
  }
  return parts.join('|')
}

/**
 * Chats snapshot that only updates when a signal-level field changes — NOT on
 * every streaming token (each token replaces useChat's `chats` map, and a
 * whole-map `useChat((s) => s.chats)` subscription re-renders the entire
 * Epics workspace per delta; PRD 833 I6). Subscribes outside the selector
 * path so no fresh values are built inside a zustand selector.
 */
export function useChatSignals(): Record<string, TabChat> {
  const [snap, setSnap] = useState<Record<string, TabChat>>(() => useChat.getState().chats)
  useEffect(() => {
    let lastSig = signatureOf(useChat.getState().chats)
    setSnap(useChat.getState().chats)
    return useChat.subscribe((s) => {
      const sig = signatureOf(s.chats)
      if (sig === lastSig) return
      lastSig = sig
      setSnap(s.chats)
    })
  }, [])
  return snap
}
