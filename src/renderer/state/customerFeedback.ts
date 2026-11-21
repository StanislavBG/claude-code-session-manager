/**
 * customerFeedback.ts — zustand store over window.api.customerFeedback.
 *
 * Single state source for the Feedback button, the feedback panel and the owner
 * inbox. Island store: imports no other renderer store (toast is a module-level
 * helper, not a store subscription). Components compute badges with the plain
 * `unseenStatusCount` function — never return a freshly built value from a selector.
 */

import { create } from 'zustand'
import type {
  CustomerFeedbackInboxItem,
  CustomerFeedbackItem,
  CustomerFeedbackOwnerInfo,
  CustomerFeedbackStatus,
  CustomerFeedbackTag,
} from '../../preload/api'
import { toast } from './toast'

export interface FeedbackDraft {
  title: string
  body: string
  tag: CustomerFeedbackTag
}

const emptyDraft = (): FeedbackDraft => ({ title: '', body: '', tag: 'bug' })

/** Items whose status changed since the user last looked. Pure — call outside selectors. */
export function unseenStatusCount(items: CustomerFeedbackItem[]): number {
  let n = 0
  for (const it of items) {
    if (it.statusAt != null && it.statusAt !== it.seenStatusAt) n++
  }
  return n
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface CustomerFeedbackState {
  panelOpen: boolean
  draft: FeedbackDraft
  items: CustomerFeedbackItem[]
  loaded: boolean
  submitting: boolean
  ownerInfo: CustomerFeedbackOwnerInfo | null
  inbox: CustomerFeedbackInboxItem[]
  inboxLoading: boolean

  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void
  setDraft: (partial: Partial<FeedbackDraft>) => void
  load: () => Promise<void>
  /** Resolves true when the host accepted the item. `images` are raw data URLs. */
  submit: (images?: { dataUrl: string }[]) => Promise<boolean>
  refreshStatus: () => Promise<void>
  markSeen: () => Promise<void>
  loadOwnerInfo: () => Promise<void>
  pullInbox: () => Promise<void>
  setInboxStatus: (id: string, status: CustomerFeedbackStatus, note?: string) => Promise<void>
  linkEpic: (id: string, epicId: string) => Promise<void>
}

export const useCustomerFeedback = create<CustomerFeedbackState>((set, get) => {
  const api = () => window.api.customerFeedback

  const reloadItems = async () => {
    set({ items: await api().list(), loaded: true })
  }

  const reloadInbox = async (): Promise<boolean> => {
    const r = await api().inboxList({})
    if (!r.ok) {
      toast.error(`Feedback inbox failed: ${r.error}`)
      return false
    }
    set({ inbox: r.items })
    return true
  }

  /** Run an action, surfacing any thrown error through toast.error. */
  const guarded = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      toast.error(`${label}: ${errText(e)}`)
    }
  }

  return {
    panelOpen: false,
    draft: emptyDraft(),
    items: [],
    loaded: false,
    submitting: false,
    ownerInfo: null,
    inbox: [],
    inboxLoading: false,

    openPanel: () => set({ panelOpen: true }),
    closePanel: () => set({ panelOpen: false }),
    togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
    setDraft: (partial) => set((s) => ({ draft: { ...s.draft, ...partial } })),

    load: () => guarded('Feedback load failed', reloadItems),

    submit: async (images) => {
      if (get().submitting) return false
      set({ submitting: true })
      try {
        const draft = get().draft
        const r = await api().submit(images && images.length > 0 ? { ...draft, images } : draft)
        if (r.ok) {
          set((s) => ({ items: [r.item, ...s.items], draft: emptyDraft() }))
          toast.info('Feedback sent — thank you')
          if (r.warning) toast.warn(r.warning)
          return true
        }
        toast.error(`Feedback not sent: ${r.error}`)
        return false
      } catch (e) {
        toast.error(`Feedback not sent: ${errText(e)}`)
        return false
      } finally {
        set({ submitting: false })
      }
    },

    refreshStatus: () =>
      guarded('Feedback status refresh failed', async () => {
        const r = await api().refreshStatus()
        if (!r.ok) toast.error(`Feedback status refresh failed: ${r.error}`)
        await reloadItems()
      }),

    markSeen: () =>
      guarded('Feedback mark-seen failed', async () => {
        await api().markSeen({})
        await reloadItems()
      }),

    loadOwnerInfo: () =>
      guarded('Feedback owner info failed', async () => {
        set({ ownerInfo: await api().ownerInfo() })
      }),

    pullInbox: async () => {
      set({ inboxLoading: true })
      await guarded('Feedback inbox pull failed', async () => {
        const r = await api().inboxPull()
        if (!r.ok) {
          toast.error(`Feedback inbox pull failed: ${r.error}`)
          return
        }
        await reloadInbox()
      })
      set({ inboxLoading: false })
    },

    setInboxStatus: (id, status, note) =>
      guarded('Feedback status update failed', async () => {
        const r = await api().inboxSetStatus({ id, status, ...(note !== undefined ? { note } : {}) })
        if (!r.ok) {
          toast.error(`Feedback status update failed: ${r.error}`)
          return
        }
        await reloadInbox()
      }),

    linkEpic: (id, epicId) =>
      guarded('Feedback epic link failed', async () => {
        const r = await api().inboxLinkEpic({ id, epicId })
        if (!r.ok) {
          toast.error(`Feedback epic link failed: ${r.error}`)
          return
        }
        await reloadInbox()
      }),
  }
})
