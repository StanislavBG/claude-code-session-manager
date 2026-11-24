/**
 * siteFeedback.ts — zustand store over window.api.siteFeedback.
 *
 * State source for the Project Home ▸ Feedback tab: one project's (cwd's) widgets,
 * inbox items and the open item. Island store: imports no other renderer store.
 *
 * Errors are never swallowed: every action resolves the SiteFeedbackResult it got
 * (a thrown IPC error becomes a `{ ok: false, error: 'ipc_error' }` failure), and the
 * failure message is also kept as that cwd's `error`. The calling component shows it
 * through useToast().
 *
 * Selectors: read a project slice with `selectSiteFeedback(cwd)`, which falls back to
 * the module-level EMPTY_SITE_FEEDBACK constant — never `?? {}` / `?? []` in a selector.
 */

import { create } from 'zustand'
import type {
  SiteFeedbackDrainResult,
  SiteFeedbackFailure,
  SiteFeedbackInboxItem,
  SiteFeedbackItemDetail,
  SiteFeedbackItemMeta,
  SiteFeedbackResult,
  SiteFeedbackStatus,
  SiteFeedbackWidget,
  SiteFeedbackWidgetPatched,
  SiteFeedbackWidgetUpdateInput,
} from '../../preload/api'

export interface SiteFeedbackProjectState {
  widgets: SiteFeedbackWidget[]
  /** Set when widgetList succeeded but the relay could not be read. */
  relayError: SiteFeedbackFailure | null
  items: SiteFeedbackInboxItem[]
  /** Status filter the last loadItems used (undefined = all). */
  statusFilter: SiteFeedbackStatus | undefined
  selectedHostId: string | null
  selected: SiteFeedbackItemDetail | null
  widgetsLoading: boolean
  itemsLoading: boolean
  itemLoading: boolean
  draining: boolean
  lastDrain: SiteFeedbackDrainResult | null
  error: string | null
}

/** Stable fallback for a cwd with no state yet — safe to return from a selector. */
export const EMPTY_SITE_FEEDBACK: SiteFeedbackProjectState = Object.freeze({
  widgets: [],
  relayError: null,
  items: [],
  statusFilter: undefined,
  selectedHostId: null,
  selected: null,
  widgetsLoading: false,
  itemsLoading: false,
  itemLoading: false,
  draining: false,
  lastDrain: null,
  error: null,
}) as SiteFeedbackProjectState

export type WidgetPatch = Omit<SiteFeedbackWidgetUpdateInput, 'boxId'>

interface SiteFeedbackState {
  byCwd: Record<string, SiteFeedbackProjectState>

  loadWidgets: (cwd: string) => Promise<SiteFeedbackResult<{ widgets: SiteFeedbackWidget[]; relayError?: SiteFeedbackFailure }>>
  createWidget: (
    cwd: string,
    label: string,
    allowedOrigins: string[],
  ) => Promise<SiteFeedbackResult<{ boxId: string; fingerprint: string; snippet: string }>>
  updateWidget: (cwd: string, boxId: string, patch: WidgetPatch) => Promise<SiteFeedbackResult<{ widget: SiteFeedbackWidgetPatched }>>
  deleteWidget: (cwd: string, boxId: string) => Promise<SiteFeedbackResult<{ boxId: string }>>
  loadItems: (cwd: string, status?: SiteFeedbackStatus) => Promise<SiteFeedbackResult<{ items: SiteFeedbackInboxItem[] }>>
  openItem: (cwd: string, hostId: string) => Promise<SiteFeedbackResult<{ item: SiteFeedbackItemDetail }>>
  closeItem: (cwd: string) => void
  setStatus: (
    cwd: string,
    hostId: string,
    status: SiteFeedbackStatus,
    note?: string | null,
  ) => Promise<SiteFeedbackResult<{ meta: SiteFeedbackItemMeta }>>
  linkEpic: (cwd: string, hostId: string, epicId: string) => Promise<SiteFeedbackResult<{ meta: SiteFeedbackItemMeta }>>
  /** Deletes one item; drops it from `items` and clears the selection when it was open. */
  removeItem: (cwd: string, hostId: string) => Promise<SiteFeedbackResult<{ hostId: string }>>
  /** Drains every box on the relay; reloads this cwd's widgets and items afterwards. */
  drainNow: (cwd: string) => Promise<SiteFeedbackResult<SiteFeedbackDrainResult>>
  clearError: (cwd: string) => void
}

/** Selector factory: `useSiteFeedback(selectSiteFeedback(cwd))`. Returns stored or constant objects only. */
export const selectSiteFeedback =
  (cwd: string) =>
  (s: SiteFeedbackState): SiteFeedbackProjectState =>
    s.byCwd[cwd] ?? EMPTY_SITE_FEEDBACK

const failureText = (f: SiteFeedbackFailure): string => f.message || f.error

/** Convert a thrown IPC error into the same failure shape the API resolves. */
const thrownFailure = (e: unknown): SiteFeedbackFailure => {
  const message = e instanceof Error ? e.message : String(e)
  return { ok: false, error: 'ipc_error', message }
}

const applyMeta = (it: SiteFeedbackInboxItem, meta: SiteFeedbackItemMeta): SiteFeedbackInboxItem =>
  it.hostId === meta.hostId ? { ...it, ...meta } : it

export const useSiteFeedback = create<SiteFeedbackState>((set, get) => {
  const api = () => window.api.siteFeedback

  const patch = (cwd: string, fn: (p: SiteFeedbackProjectState) => Partial<SiteFeedbackProjectState>) =>
    set((s) => {
      const cur = s.byCwd[cwd] ?? EMPTY_SITE_FEEDBACK
      return { byCwd: { ...s.byCwd, [cwd]: { ...cur, ...fn(cur) } } }
    })

  /** Call the API; on failure (resolved or thrown) record `error` for the cwd and return the failure. */
  const call = async <T>(
    cwd: string,
    fn: () => Promise<SiteFeedbackResult<T>>,
    onOk: (r: { ok: true } & T, cur: SiteFeedbackProjectState) => Partial<SiteFeedbackProjectState>,
  ): Promise<SiteFeedbackResult<T>> => {
    let r: SiteFeedbackResult<T>
    try {
      r = await fn()
    } catch (e) {
      r = thrownFailure(e)
    }
    if (r.ok) {
      const ok = r
      patch(cwd, (cur) => ({ ...onOk(ok, cur), error: null }))
    } else {
      const f = r
      patch(cwd, () => ({ error: failureText(f) }))
    }
    return r
  }

  const withFlag = async <R>(
    cwd: string,
    flag: 'widgetsLoading' | 'itemsLoading' | 'itemLoading' | 'draining',
    run: () => Promise<R>,
  ): Promise<R> => {
    patch(cwd, () => ({ [flag]: true }))
    try {
      return await run()
    } finally {
      patch(cwd, () => ({ [flag]: false }))
    }
  }

  return {
    byCwd: {},

    loadWidgets: (cwd) =>
      withFlag(cwd, 'widgetsLoading', () =>
        call(cwd, () => api().widgetList({ cwd }), (r) => ({ widgets: r.widgets, relayError: r.relayError ?? null })),
      ),

    createWidget: async (cwd, label, allowedOrigins) => {
      const r = await call(cwd, () => api().widgetCreate({ cwd, label, allowedOrigins }), () => ({}))
      if (r.ok) await get().loadWidgets(cwd)
      return r
    },

    updateWidget: (cwd, boxId, p) =>
      call(cwd, () => api().widgetUpdate({ boxId, ...p }), (r, cur) => ({
        widgets: cur.widgets.map((w) => {
          if (w.boxId !== boxId) return w
          const next: SiteFeedbackWidget = { ...w }
          if (r.widget.label !== undefined) next.label = r.widget.label
          if (r.widget.allowedOrigins !== undefined) next.allowedOrigins = r.widget.allowedOrigins
          if (r.widget.state !== undefined) next.state = r.widget.state
          if (r.widget.pending !== undefined) next.pending = r.widget.pending
          return next
        }),
      })),

    deleteWidget: (cwd, boxId) =>
      call(cwd, () => api().widgetDelete({ boxId }), (_r, cur) => ({
        widgets: cur.widgets.filter((w) => w.boxId !== boxId),
      })),

    loadItems: (cwd, status) =>
      withFlag(cwd, 'itemsLoading', () =>
        call(
          cwd,
          () => api().inboxList(status !== undefined ? { cwd, status } : { cwd }),
          (r) => ({ items: r.items, statusFilter: status }),
        ),
      ),

    openItem: (cwd, hostId) => {
      patch(cwd, () => ({ selectedHostId: hostId, selected: null }))
      return withFlag(cwd, 'itemLoading', () =>
        call(cwd, () => api().inboxGet({ cwd, hostId }), (r, cur) =>
          // A later openItem won the race — keep its selection.
          cur.selectedHostId === hostId ? { selected: r.item } : {},
        ),
      )
    },

    closeItem: (cwd) => patch(cwd, () => ({ selectedHostId: null, selected: null })),

    setStatus: (cwd, hostId, status, note) =>
      call(
        cwd,
        () => api().inboxSetStatus(note !== undefined ? { cwd, hostId, status, note } : { cwd, hostId, status }),
        (r, cur) => ({
          items: cur.items.map((it) => applyMeta(it, r.meta)),
          selected: cur.selected && cur.selected.meta.hostId === hostId ? { ...cur.selected, meta: r.meta } : cur.selected,
        }),
      ),

    linkEpic: (cwd, hostId, epicId) =>
      call(cwd, () => api().inboxLinkEpic({ cwd, hostId, epicId }), (r, cur) => ({
        items: cur.items.map((it) => applyMeta(it, r.meta)),
        selected: cur.selected && cur.selected.meta.hostId === hostId ? { ...cur.selected, meta: r.meta } : cur.selected,
      })),

    removeItem: (cwd, hostId) =>
      call(cwd, () => api().inboxRemove({ cwd, hostId }), (_r, cur) => ({
        items: cur.items.filter((it) => it.hostId !== hostId),
        ...(cur.selectedHostId === hostId ? { selectedHostId: null, selected: null } : {}),
      })),

    drainNow: async (cwd) => {
      const r = await withFlag(cwd, 'draining', () =>
        call(cwd, () => api().drainNow(), (ok) => ({
          lastDrain: {
            stored: ok.stored,
            duplicates: ok.duplicates,
            rejected: ok.rejected,
            goneBoxes: ok.goneBoxes,
            heldBoxes: ok.heldBoxes,
          },
        })),
      )
      if (r.ok) {
        const filter = (get().byCwd[cwd] ?? EMPTY_SITE_FEEDBACK).statusFilter
        await Promise.all([get().loadWidgets(cwd), get().loadItems(cwd, filter)])
      }
      return r
    },

    clearError: (cwd) => patch(cwd, () => ({ error: null })),
  }
})
