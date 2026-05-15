import { create } from 'zustand'

/**
 * Lightweight toast store. Surfaces user-facing errors that previously
 * were swallowed into console.error / console.warn.
 *
 * Behavior:
 *   - Each toast auto-expires after AUTO_EXPIRE_MS (5s).
 *   - Stack is capped at MAX_TOASTS (5); FIFO drop when full.
 *   - `dismiss(id)` removes a toast manually; clears its expiry timer.
 *
 * Mount the `<Toast />` host once at the root (see App.tsx). Use the
 * module-level shortcuts `toast.info / toast.warn / toast.error`.
 *
 * Time complexity: O(1) show, O(n) dismiss (n ≤ 5).
 */

export type ToastKind = 'info' | 'warn' | 'error'

export interface ToastEntry {
  id: string
  kind: ToastKind
  message: string
  createdAt: number
}

interface ToastState {
  toasts: ToastEntry[]
  show: (kind: ToastKind, message: string) => string
  dismiss: (id: string) => void
}

const MAX_TOASTS = 5
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

export const useToast = create<ToastState>((set, get) => ({
  toasts: [],
  show: (kind, message) => {
    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => {
      const next = [...s.toasts, { id, kind, message, createdAt: Date.now() }]
      // FIFO drop when over cap.
      while (next.length > MAX_TOASTS) {
        const dropped = next.shift()
        if (dropped) clearTimer(dropped.id)
      }
      return { toasts: next }
    })
    const handle = setTimeout(() => get().dismiss(id), AUTO_EXPIRE_MS)
    timers.set(id, handle)
    return id
  },
  dismiss: (id) => {
    clearTimer(id)
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))

/** Module-level shortcuts. Call from anywhere in the renderer. */
export const toast = {
  info: (message: string) => useToast.getState().show('info', message),
  warn: (message: string) => useToast.getState().show('warn', message),
  error: (message: string) => useToast.getState().show('error', message),
}
