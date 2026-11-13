import { create } from 'zustand'
import type { AppPreviewState } from '../../preload/api'
import { toast } from './toast'

/**
 * Runtime-only store of each Epic's dev-server preview (app preview plan).
 * Island store keyed by epicId; hydrated from `window.api.appPreview.list()`
 * and kept current by `onChanged`. A failed or unexpectedly stopped preview
 * surfaces as an error toast so dev-server errors are never silent.
 */

interface AppPreviewStore {
  byEpic: Record<string, AppPreviewState>
  upsert: (state: AppPreviewState) => void
}

/** epicId:startedAt:status keys already toasted — one toast per transition. */
const toasted = new Set<string>()
let subscribed = false

function toastFor(state: AppPreviewState): void {
  const key = `${state.epicId}:${state.startedAt}:${state.status}`
  if (state.status === 'failed') {
    if (toasted.has(key)) return
    toasted.add(key)
    toast.error('Preview failed: ' + (state.error ?? 'unknown error'))
  } else if (state.status === 'stopped' && state.error != null) {
    if (toasted.has(key)) return
    toasted.add(key)
    toast.error(state.error)
  } else if (state.status === 'running') {
    if (toasted.has(key)) return
    toasted.add(key)
    toast.info('Preview running at ' + (state.url ?? `port ${state.port}`))
  }
}

export const useAppPreview = create<AppPreviewStore>((set) => ({
  byEpic: {},
  upsert: (state) => {
    set((s) => ({ byEpic: { ...s.byEpic, [state.epicId]: state } }))
    toastFor(state)
  },
}))

/** Subscribe + hydrate once per page load; no-op without the preload namespace. */
export function ensureAppPreviewSubscription(): void {
  if (subscribed) return
  if (typeof window === 'undefined' || !window || !window.api?.appPreview) return
  subscribed = true
  const api = window.api.appPreview
  const { upsert } = useAppPreview.getState()
  api.onChanged((state) => upsert(state))
  api
    .list()
    .then((states) => {
      useAppPreview.setState((s) => {
        const byEpic = { ...s.byEpic }
        for (const st of states) {
          // A live onChanged that arrived before hydration wins.
          if (!(st.epicId in byEpic)) byEpic[st.epicId] = st
        }
        return { byEpic }
      })
    })
    .catch((err: unknown) => {
      toast.error('Could not load app previews: ' + (err instanceof Error ? err.message : String(err)))
    })
}
