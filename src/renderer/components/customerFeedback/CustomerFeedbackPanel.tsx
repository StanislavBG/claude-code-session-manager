/**
 * CustomerFeedbackPanel — full-height panel docked to the LEFT edge where a
 * user submits Header/Body/tag feedback and sees every item they have sent
 * with its resolution status. Driven entirely by useCustomerFeedback; mirrors
 * HomeSessionDrawer's portal/ESC/backdrop/slide pattern, mirrored to the left.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '../../lib/zLayers'
import { useCustomerFeedback } from '../../state/customerFeedback'
import type { CustomerFeedbackStatus, CustomerFeedbackTag } from '../../../preload/api'

const STATUS_LABEL: Record<CustomerFeedbackStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  wontfix: "Won't fix",
}

const TAGS: { tag: CustomerFeedbackTag; label: string }[] = [
  { tag: 'bug', label: 'Bug' },
  { tag: 'feature', label: 'Feature' },
  { tag: 'discussion', label: 'Discussion' },
]

const TAG_LABEL: Record<CustomerFeedbackTag, string> = { bug: 'Bug', feature: 'Feature', discussion: 'Discussion' }

const TITLE_MAX = 120
const BODY_MAX = 4000

export function CustomerFeedbackPanel() {
  const panelOpen = useCustomerFeedback((s) => s.panelOpen)
  const draft = useCustomerFeedback((s) => s.draft)
  const items = useCustomerFeedback((s) => s.items)
  const submitting = useCustomerFeedback((s) => s.submitting)
  const closePanel = useCustomerFeedback((s) => s.closePanel)
  const setDraft = useCustomerFeedback((s) => s.setDraft)
  const submit = useCustomerFeedback((s) => s.submit)
  const load = useCustomerFeedback((s) => s.load)
  const loadOwnerInfo = useCustomerFeedback((s) => s.loadOwnerInfo)
  const refreshStatus = useCustomerFeedback((s) => s.refreshStatus)
  const markSeen = useCustomerFeedback((s) => s.markSeen)
  const [entered, setEntered] = useState(false)

  const sorted = useMemo(() => [...items].sort((a, b) => b.submittedAt - a.submittedAt), [items])

  useEffect(() => {
    if (!panelOpen) {
      setEntered(false)
      return
    }
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [panelOpen])

  useEffect(() => {
    if (!panelOpen) return
    let cancelled = false
    void (async () => {
      await Promise.all([load(), loadOwnerInfo(), refreshStatus()])
      if (!cancelled) await markSeen()
    })()
    return () => {
      cancelled = true
    }
  }, [panelOpen, load, loadOwnerInfo, refreshStatus, markSeen])

  useEffect(() => {
    if (!panelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closePanel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panelOpen, closePanel])

  if (!panelOpen) return null

  const blank = draft.title.trim() === '' || draft.body.trim() === ''

  const node = (
    <div className={`fixed inset-0 ${Z.dialog}`} data-testid="customer-feedback-root">
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-[220ms] ${entered ? 'opacity-100' : 'opacity-0'}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closePanel()
        }}
        data-testid="customer-feedback-backdrop"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        className={`absolute left-0 top-0 h-full w-full max-w-[480px] border-r border-line bg-bg-elev text-fg shadow-xl flex flex-col transition-transform duration-[220ms] ${
          entered ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(.32,.72,.28,1)' }}
        data-testid="customer-feedback-panel"
      >
        <header className="px-5 py-4 border-b border-line flex items-center justify-between gap-3 shrink-0">
          <h2 className="m-0 font-serif text-[18px] font-semibold text-fg">Feedback</h2>
          <button
            onClick={closePanel}
            className="shrink-0 rounded-md border border-line bg-bg px-2.5 py-1 text-[12px] font-semibold text-fg-dim hover:bg-bg-elev"
            aria-label="Close"
            data-testid="customer-feedback-close"
          >
            Close
          </button>
        </header>
        <div className="flex-1 min-h-0 overflow-auto px-5 py-4 grid gap-5 content-start">
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (!blank && !submitting) void submit()
            }}
          >
            <label className="grid gap-1">
              <span className="flex justify-between font-mono text-[11px] uppercase tracking-[0.05em] text-fg-dim">
                <span>Header</span>
                <span>
                  {draft.title.length}/{TITLE_MAX}
                </span>
              </span>
              <input
                value={draft.title}
                maxLength={TITLE_MAX}
                onChange={(e) => setDraft({ title: e.target.value })}
                className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg"
                data-testid="customer-feedback-title"
              />
            </label>
            <label className="grid gap-1">
              <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-fg-dim">Body</span>
              <textarea
                value={draft.body}
                maxLength={BODY_MAX}
                rows={6}
                onChange={(e) => setDraft({ body: e.target.value })}
                className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg resize-y"
                data-testid="customer-feedback-body"
              />
            </label>
            <div className="flex gap-2" role="group" aria-label="Feedback type">
              {TAGS.map(({ tag, label }) => (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={draft.tag === tag}
                  onClick={() => setDraft({ tag })}
                  className={`rounded-md border border-line px-3 py-1 text-[12px] font-semibold ${
                    draft.tag === tag ? 'bg-accent text-white' : 'bg-bg text-fg-dim hover:bg-bg-elev'
                  }`}
                  data-testid={`customer-feedback-tag-${tag}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="m-0 text-[11.5px] text-fg-dim">
              Your feedback is sent to bilko.run. Please don&apos;t paste secrets, keys or passwords.
            </p>
            <button
              type="submit"
              disabled={blank || submitting}
              className="rounded-md bg-accent px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
              data-testid="customer-feedback-submit"
            >
              {submitting ? 'Sending…' : 'Submit'}
            </button>
          </form>

          <section className="grid gap-2" data-testid="customer-feedback-list">
            <h3 className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-fg-dim">Your feedback</h3>
            {sorted.length === 0 ? (
              <p className="m-0 text-[12.5px] text-fg-dim">No feedback yet — what you send will show up here.</p>
            ) : (
              sorted.map((it) => (
                <div
                  key={it.id}
                  className="rounded-lg border border-line bg-bg px-3 py-2 grid gap-1"
                  data-testid="customer-feedback-item"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 text-[13px] font-semibold text-fg break-words">{it.title}</div>
                    <span
                      className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] font-semibold text-fg-dim"
                      data-testid="customer-feedback-status"
                    >
                      {STATUS_LABEL[it.status]}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-fg-dim">
                    {TAG_LABEL[it.tag]} · {new Date(it.submittedAt).toLocaleDateString()}
                  </div>
                  {it.statusNote && <div className="text-[12px] text-fg-dim break-words">{it.statusNote}</div>}
                </div>
              ))
            )}
          </section>
        </div>
        {/* owner inbox mounts here (cf-owner-inbox-ui) */}
      </aside>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
