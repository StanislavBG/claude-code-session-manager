import { create } from 'zustand'
import type { ActionOutcome } from '../../preload/api'

/**
 * Lightweight toast store. Surfaces user-facing errors that previously
 * were swallowed into console.error / console.warn.
 *
 * Behavior:
 *   - Each toast auto-expires after AUTO_EXPIRE_MS (5s).
 *   - Stack is capped at MAX_TOASTS (5); FIFO drop when full.
 *   - `dismiss(id)` removes a toast manually; clears its expiry timer.
 *
 * History:
 *   - Every `show()` also pushes a NotificationRecord into `history`,
 *     capped at MAX_HISTORY (100; oldest evicted). The history persists
 *     after the toast itself auto-expires, so NotificationCenter can
 *     surface past errors for review. Records start unread; `markAllRead`
 *     and `clearHistory` operate on history only — they don't touch
 *     in-flight toasts.
 *
 * Mount the `<Toast />` host once at the root (see App.tsx). Use the
 * module-level shortcuts `toast.info / toast.warn / toast.error`.
 *
 * Time complexity: O(1) show, O(n) dismiss (n ≤ 5), O(1) history append.
 */

export type ToastKind = 'info' | 'warn' | 'error'

export interface ToastEntry {
  id: string
  kind: ToastKind
  message: string
  createdAt: number
}

export interface NotificationRecord {
  id: string
  kind: ToastKind
  message: string
  createdAt: number
  read: boolean
}

interface ToastState {
  toasts: ToastEntry[]
  history: NotificationRecord[]
  unreadCount: number
  show: (kind: ToastKind, message: string) => string
  dismiss: (id: string) => void
  markAllRead: () => void
  clearHistory: () => void
  dismissHistoryEntry: (id: string) => void
}

const MAX_TOASTS = 5
const MAX_HISTORY = 100
const AUTO_EXPIRE_MS = 5_000

// Per-id timer registry kept outside the store so it doesn't trigger re-renders.
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(id: string) {
  const t = timers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(id)
  }
}

function genId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  history: [],
  unreadCount: 0,
  show: (kind, message) => {
    const id = genId()
    const now = Date.now()
    set((s) => {
      // Toast stack (capped FIFO).
      const nextToasts = [...s.toasts, { id, kind, message, createdAt: now }]
      while (nextToasts.length > MAX_TOASTS) {
        const dropped = nextToasts.shift()
        if (dropped) clearTimer(dropped.id)
      }
      // History — newest first, capped at MAX_HISTORY.
      const record: NotificationRecord = { id, kind, message, createdAt: now, read: false }
      const nextHistory = [record, ...s.history]
      if (nextHistory.length > MAX_HISTORY) nextHistory.length = MAX_HISTORY
      return {
        toasts: nextToasts,
        history: nextHistory,
        unreadCount: s.unreadCount + 1,
      }
    })
    const handle = setTimeout(() => get().dismiss(id), AUTO_EXPIRE_MS)
    timers.set(id, handle)
    return id
  },
  dismiss: (id) => {
    clearTimer(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
  markAllRead: () => {
    set((s) => {
      if (s.unreadCount === 0) return s
      return {
        history: s.history.map((r) => (r.read ? r : { ...r, read: true })),
        unreadCount: 0,
      }
    })
  },
  clearHistory: () => {
    set({ history: [], unreadCount: 0 })
  },
  dismissHistoryEntry: (id) => {
    set((s) => {
      const next = s.history.filter((r) => r.id !== id)
      if (next.length === s.history.length) return s
      const wasUnread = s.history.find((r) => r.id === id && !r.read)
      return {
        history: next,
        unreadCount: wasUnread ? Math.max(0, s.unreadCount - 1) : s.unreadCount,
      }
    })
  },
}))

/** Module-level shortcuts. Call from anywhere in the renderer. */
export const toast = {
  info: (message: string) => useToast.getState().show('info', message),
  warn: (message: string) => useToast.getState().show('warn', message),
  error: (message: string) => useToast.getState().show('error', message),
  fromOutcome: (outcome: ActionOutcome) =>
    useToast.getState().show(outcome.kind ?? (outcome.ok ? 'info' : 'warn'), outcome.message),
}
