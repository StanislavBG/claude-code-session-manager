/**
 * CustomerFeedbackPanel — full-height panel docked to the LEFT edge where a
 * user submits Goal/Description/tag feedback plus up to 5 images (paste, drop
 * or the Add images picker) and sees every item they have sent with its
 * resolution status. Images go to main as raw data URLs; main validates and
 * downscales them. Driven entirely by useCustomerFeedback; mirrors
 * HomeSessionDrawer's portal/ESC/backdrop/slide pattern, mirrored to the left.
 *
 * The owner's Customer inbox lives in Project Home > Feedback of `ownerInfo.projectCwd`
 * (ProjectFeedback); in owner mode this panel only links there, so there is one inbox screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Z } from '../../lib/zLayers'
import { useCustomerFeedback } from '../../state/customerFeedback'
import { useToast } from '../../state/toast'
import { copyText } from '../../lib/clipboard'
import { openFreeHour } from '../../lib/freeHour'
import { useSessions } from '../../state/sessions'
import { isOwnerProject } from '../tabs/projecthome/ProjectFeedback'
import { useAttachments } from '../epics/attachments'
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

const SESSION_PHRASE = 'Send this to Session Manager as feedback, with any screenshots I attached.'

const TITLE_MAX = 120
const BODY_MAX = 5000
const IMAGE_MAX = 5
const IMAGE_MAX_BYTES = 25 * 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Switch to (or open) the owner project's tab, then show its Project Home > Feedback. */
function openOwnerFeedback(projectCwd: string): void {
  const sessions = useSessions.getState()
  const existing = sessions.tabs.find((t) => isOwnerProject(t.cwd, projectCwd))
  if (existing) sessions.setActive(existing.id)
  else sessions.addSessionToProject(projectCwd)
  // The intent names the project, so only its Project Home consumes it, and App.tsx's
  // tab-switch effect sees it and keeps this navigation instead of routing to the terminal.
  useCustomerFeedback.getState().requestFeedbackTab(projectCwd)
  window.dispatchEvent(new CustomEvent('sm:navigate', { detail: 'project-home' }))
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error(`could not read ${file.name || 'image'}`))
    r.readAsDataURL(file)
  })
}

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
  const ownerMode = useCustomerFeedback((s) => s.ownerInfo?.ownerMode === true)
  const ownerProjectCwd = useCustomerFeedback((s) => s.ownerInfo?.projectCwd ?? null)
  const showToast = useToast((s) => s.show)
  const [entered, setEntered] = useState(false)
  const [mcpReady, setMcpReady] = useState(false)
  const att = useAttachments()
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // The session hint only makes sense when the scheduler MCP server (which
  // carries customer_feedback_submit) is registered for sessions.
  useEffect(() => {
    setMcpReady(false)
    if (!panelOpen) return
    let cancelled = false
    void (async () => {
      try {
        const s = await window.api?.app?.seedStatus?.()
        if (!cancelled) setMcpReady(s?.['scheduler-mcp']?.status === 'done')
      } catch {
        /* no seed status — hint stays hidden */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [panelOpen])

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

  const addImages = (files: FileList | File[] | null | undefined) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    const accepted: File[] = []
    for (const f of list) {
      const name = f.name || 'pasted image'
      if (!IMAGE_TYPES.includes(f.type)) {
        showToast('error', `${name} is not a PNG, JPEG, WebP or GIF image.`)
      } else if (f.size > IMAGE_MAX_BYTES) {
        showToast('error', `${name} is over 25 MB.`)
      } else if (att.items.length + accepted.length >= IMAGE_MAX) {
        showToast('error', `You can attach up to ${IMAGE_MAX} images.`)
        break
      } else {
        accepted.push(f)
      }
    }
    if (accepted.length) att.add(accepted)
  }

  const onSubmit = async () => {
    let images: { dataUrl: string }[]
    try {
      images = await Promise.all(att.items.map(async (i) => ({ dataUrl: await readDataUrl(i.file) })))
    } catch (e) {
      showToast('error', `Could not read an image: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (await submit(images)) att.clear()
  }

  const copyPhrase = async () => {
    if (await copyText(SESSION_PHRASE)) showToast('info', 'Copied — paste it into your session.')
    else showToast('error', 'Could not copy to the clipboard.')
  }

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
              if (!blank && !submitting) void onSubmit()
            }}
            onPaste={(e) => {
              const files = e.clipboardData?.files
              if (!files || files.length === 0) return
              e.preventDefault()
              addImages(files)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
            }}
            onDrop={(e) => {
              const files = e.dataTransfer?.files
              if (!files || files.length === 0) return
              e.preventDefault()
              addImages(files)
            }}
            data-testid="customer-feedback-form"
          >
            {mcpReady && (
              <div className="flex items-start gap-2">
                <p className="m-0 flex-1 text-[12.5px] text-fg-dim" data-testid="customer-feedback-session-hint">
                  Already talking about this in a session? Ask it: &quot;{SESSION_PHRASE}&quot; It uses what the session
                  already knows, so you don&apos;t retype it, and the item shows up here.
                </p>
                <button
                  type="button"
                  className="shrink-0 text-[12.5px] font-semibold text-accent hover:underline"
                  aria-label="Copy the phrase to ask your session"
                  data-testid="customer-feedback-session-hint-copy"
                  onClick={() => void copyPhrase()}
                >
                  Copy
                </button>
              </div>
            )}
            <label className="grid gap-1">
              <span className="flex justify-between font-mono text-[11px] uppercase tracking-[0.05em] text-fg-dim">
                <span>Goal</span>
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
              <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-fg-dim">Description</span>
              <textarea
                value={draft.body}
                maxLength={BODY_MAX}
                rows={6}
                onChange={(e) => setDraft({ body: e.target.value })}
                className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg resize-y"
                data-testid="customer-feedback-body"
              />
            </label>
            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={att.items.length >= IMAGE_MAX}
                  className="rounded-md border border-line bg-bg px-2.5 py-1 text-[12px] font-semibold text-fg-dim hover:bg-bg-elev disabled:opacity-50"
                  title="Add images — or paste a screenshot or drop images onto the form"
                  data-testid="customer-feedback-add-images"
                >
                  Add images
                </button>
                <span className="font-mono text-[11px] text-fg-dim">
                  {att.items.length}/{IMAGE_MAX} images
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={IMAGE_TYPES.join(',')}
                  className="hidden"
                  onChange={(e) => {
                    addImages(e.target.files)
                    e.target.value = ''
                  }}
                  data-testid="customer-feedback-images-input"
                />
              </div>
              {att.items.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {att.items.map((i) => (
                    <div
                      key={i.id}
                      className="relative h-16 w-16 overflow-hidden rounded-md border border-line bg-bg"
                      data-testid="customer-feedback-image"
                    >
                      {i.url && <img src={i.url} alt={i.name} className="h-full w-full object-cover" />}
                      <button
                        type="button"
                        onClick={() => att.remove(i.id)}
                        aria-label={`Remove ${i.name}`}
                        title="Remove"
                        className="absolute right-0.5 top-0.5 rounded bg-black/60 px-1 text-[11px] leading-4 text-white hover:bg-black/80"
                        data-testid="customer-feedback-image-remove"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
              Your feedback, including any screenshots, is sent to bilko.run. Please don&apos;t include secrets, keys
              or passwords.
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

          <p className="m-0 text-[12.5px] text-fg-dim" data-testid="customer-feedback-free-hour">
            Want to chat?{' '}
            <button
              type="button"
              className="font-semibold text-accent hover:underline"
              data-testid="customer-feedback-free-hour-link"
              onClick={openFreeHour}
            >
              Book a free consultation
            </button>
            .
          </p>

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
        {ownerMode && (
          <div
            className="shrink-0 border-t border-line px-5 py-3 flex items-center justify-between gap-3"
            data-testid="customer-feedback-inbox-moved"
          >
            <p className="m-0 text-[12.5px] text-fg-dim">Customer inbox moved to Project Home &gt; Feedback</p>
            <button
              type="button"
              disabled={!ownerProjectCwd}
              title={ownerProjectCwd ? `Open Project Home > Feedback for ${ownerProjectCwd}` : 'No owner project is configured'}
              onClick={() => {
                if (!ownerProjectCwd) return
                openOwnerFeedback(ownerProjectCwd)
                closePanel()
              }}
              className="shrink-0 rounded-md border border-line bg-bg px-2.5 py-1 text-[12px] font-semibold text-accent hover:bg-bg-elev disabled:opacity-50"
              data-testid="customer-feedback-inbox-open-project-home"
            >
              Open
            </button>
          </div>
        )}
      </aside>
    </div>
  )

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(node, document.body)
  }
  return node
}
