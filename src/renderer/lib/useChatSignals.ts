import { useEffect, useState } from 'react'
import { useChat, type TabChat } from '../state/chat'

/**
 * Signal-level signature of the chats record: everything the Epics queue's
 * derive helpers (epicDisplayStatus/epicStats) actually read — running flag,
 * queue position, needs-input, turn count, tool-call count — and nothing
 * token-level (`stream` grows on every delta and is deliberately excluded).
 *
 * `stream` DOES have a consumer now (EpicDetail.tsx's live turn bubble,
 * PRD 837) — it just doesn't come through this hook. EpicDetail subscribes
 * directly to its own single chat slice (`useChat((s) => s.chats[epicId])`),
 * which is already scoped to one Epic, so per-token re-renders there only
 * repaint that Epic's own pane. Folding `stream` into this signature would
 * re-render the whole Epics workspace (every card, via this hook) on every
 * delta of any running Epic — the exact fan-out this hook exists to avoid.
 */
// Per-chat piece of the signature, cached by TabChat object reference. A
// chat's `turns`/`ticketHistory` are only ever appended-to via a fresh array
// (pushTurn/applyNotice etc.), so an unchanged TabChat reference means an
// unchanged signature piece — recomputing it by re-walking every turn's
// toolUses was O(total turns across every Epic ever opened this session) on
// EVERY store update (any streamed token from any running chat), since a
// single chat's mutation replaces the whole `chats` map and this used to
// rescan all of it. A WeakMap lets stale entries (for TabChat objects no
// chat mutation will ever reference again) get garbage-collected on their
// own — no manual eviction needed.
const pieceCache = new WeakMap<TabChat, string>()

function pieceOf(id: string, c: TabChat): string {
  const cached = pieceCache.get(c)
  if (cached !== undefined) return cached
  let needs = 0
  for (const t of c.ticketHistory ?? []) if (t.status === 'needs-input') needs = 1
  let tools = 0
  for (const t of c.turns) tools += t.toolUses?.length ?? 0
  const piece = `${id}:${c.running ? 1 : 0}:${c.queuedPosition ?? 0}:${c.turns.length}:${tools}:${needs}`
  pieceCache.set(c, piece)
  return piece
}

function signatureOf(chats: Record<string, TabChat>): string {
  const parts: string[] = []
  for (const id of Object.keys(chats)) parts.push(pieceOf(id, chats[id]))
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
