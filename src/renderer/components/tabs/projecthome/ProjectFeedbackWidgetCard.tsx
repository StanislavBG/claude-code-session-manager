/**
 * ProjectFeedbackWidgetCard — Project Home ▸ Feedback ▸ Website widget.
 *
 * Lets the owner create this project's website-feedback widget (a bilko.run relay box), see the
 * sites allowed to embed it, copy its one-line snippet, and pause, resume or delete it.
 *
 * Data: the `siteFeedback` store slice for `cwd` (ProjectFeedback loads it). Host failures are
 * shown through `useToast().show('error', …)` with the service's one-line explanation; a
 * `not_linked` failure (from the list's relayError or from create) swaps the card for a prompt
 * that opens App Settings ▸ Phone remote.
 */

import { useState } from 'react'
import { selectSiteFeedback, useSiteFeedback } from '../../../state/siteFeedback'
import { useToast } from '../../../state/toast'
import { useLayout } from '../../../state/layout'
import { copyText } from '../../../lib/clipboard'
import type { SiteFeedbackFailure, SiteFeedbackWidget } from '../../../../preload/api'

const MAX_SITES = 10
const MAX_LABEL = 80

/** Folder name of a cwd — the default widget label. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** True for an https origin, or http on localhost / 127.0.0.1. */
export function isAllowedSite(site: string): boolean {
  let u: URL
  try {
    u = new URL(site)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return u.hostname.length > 0
  if (u.protocol === 'http:') return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  return false
}

export interface WidgetFormErrors {
  label?: string
  sites?: string
}

/** Validate the create form; returns errors (empty = valid) and the parsed site list. */
export function validateWidgetForm(label: string, sitesText: string): { errors: WidgetFormErrors; sites: string[] } {
  const errors: WidgetFormErrors = {}
  const trimmed = label.trim()
  if (trimmed.length === 0) errors.label = 'Give the widget a label'
  else if (trimmed.length > MAX_LABEL) errors.label = `Keep the label to ${MAX_LABEL} characters or fewer`
  const sites = sitesText
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (sites.length === 0) errors.sites = 'Add at least one site'
  else if (sites.length > MAX_SITES) errors.sites = `At most ${MAX_SITES} sites`
  else {
    const bad = sites.find((s) => !isAllowedSite(s))
    if (bad) errors.sites = `${bad} is not an https site (http is allowed only for localhost or 127.0.0.1)`
  }
  return { errors, sites }
}

const failureMessage = (f: SiteFeedbackFailure): string => f.message || f.error

function stateLabel(state: SiteFeedbackWidget['state']): string {
  if (state === 'open' || state === 'paused' || state === 'gone') return state
  return 'unknown'
}

export function ProjectFeedbackWidgetCard({ cwd }: { cwd: string }) {
  const state = useSiteFeedback(selectSiteFeedback(cwd))
  const createWidget = useSiteFeedback((s) => s.createWidget)
  const updateWidget = useSiteFeedback((s) => s.updateWidget)
  const deleteWidget = useSiteFeedback((s) => s.deleteWidget)
  const showToast = useToast((s) => s.show)

  const [label, setLabel] = useState(() => folderName(cwd))
  const [sitesText, setSitesText] = useState('')
  const [errors, setErrors] = useState<WidgetFormErrors>({})
  const [creating, setCreating] = useState(false)
  const [snippet, setSnippet] = useState<string | null>(null)
  const [createNotLinked, setCreateNotLinked] = useState(false)
  const [busyBox, setBusyBox] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const notLinked = createNotLinked || state.relayError?.error === 'not_linked'

  const fail = (f: SiteFeedbackFailure) => {
    if (f.error === 'not_linked') setCreateNotLinked(true)
    showToast('error', failureMessage(f))
  }

  const copy = async (text: string) => {
    const ok = await copyText(text)
    if (ok) showToast('info', 'Snippet copied')
    else showToast('error', 'Could not copy the snippet to the clipboard')
  }

  const onCreate = async () => {
    const { errors: next, sites } = validateWidgetForm(label, sitesText)
    setErrors(next)
    if (next.label || next.sites) return
    setCreating(true)
    try {
      const r = await createWidget(cwd, label.trim(), sites)
      if (r.ok) {
        setSnippet(r.snippet)
        setSitesText('')
      } else fail(r)
    } finally {
      setCreating(false)
    }
  }

  const onToggle = async (w: SiteFeedbackWidget) => {
    setBusyBox(w.boxId)
    try {
      const r = await updateWidget(cwd, w.boxId, { state: w.state === 'paused' ? 'open' : 'paused' })
      if (!r.ok) fail(r)
    } finally {
      setBusyBox(null)
    }
  }

  const onDelete = async (w: SiteFeedbackWidget) => {
    setConfirmDelete(null)
    setBusyBox(w.boxId)
    try {
      const r = await deleteWidget(cwd, w.boxId)
      if (!r.ok) fail(r)
    } finally {
      setBusyBox(null)
    }
  }

  const openPairing = () => useLayout.getState().openPanel('app-settings', 'remote')

  if (notLinked) {
    return (
      <div data-testid="feedback-widget-card" data-state="not-linked" className="flex flex-col items-start gap-2 rounded border border-line p-3">
        <p data-testid="feedback-widget-not-linked" className="text-[13px]">
          Link this desktop to your bilko.run account first
        </p>
        <button
          type="button"
          data-testid="feedback-widget-open-pairing"
          onClick={openPairing}
          className="rounded border border-line px-2.5 py-1 text-[12.5px] hover:bg-bg-hover"
        >
          Open Phone remote pairing
        </button>
      </div>
    )
  }

  return (
    <div data-testid="feedback-widget-card" data-state="linked" className="flex flex-col gap-3 rounded border border-line p-3">
      {state.widgets.length > 0 && (
        <ul data-testid="feedback-widget-list" className="flex flex-col gap-2">
          {state.widgets.map((w) => {
            const st = stateLabel(w.state)
            const busy = busyBox === w.boxId
            return (
              <li
                key={w.boxId}
                data-testid="feedback-widget-row"
                data-box-id={w.boxId}
                data-widget-state={st}
                className="flex flex-col gap-1 rounded border border-line p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span data-testid="feedback-widget-label" className="text-[13px] font-medium">
                    {w.label}
                  </span>
                  <span data-testid="feedback-widget-state" className="rounded bg-bg-hover px-1.5 text-[11px] text-fg-dim">
                    {st}
                  </span>
                  <span data-testid="feedback-widget-pending" className="text-[11.5px] text-fg-faint">
                    {w.pending === null ? 'pending unknown' : `${w.pending} pending`}
                  </span>
                </div>
                <div data-testid="feedback-widget-sites" className="text-[12px] text-fg-dim">
                  {w.allowedOrigins.length > 0 ? w.allowedOrigins.join(', ') : 'No sites listed'}
                </div>
                {w.hint && <div className="text-[11.5px] text-fg-faint">{w.hint}</div>}
                <div className="flex flex-wrap gap-2">
                  {(st === 'open' || st === 'paused') && (
                    <button
                      type="button"
                      data-testid="feedback-widget-toggle"
                      disabled={busy}
                      onClick={() => void onToggle(w)}
                      className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover disabled:opacity-50"
                    >
                      {st === 'paused' ? 'Resume' : 'Pause'}
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="feedback-widget-copy"
                    onClick={() => void copy(w.snippet)}
                    className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover"
                  >
                    Copy snippet
                  </button>
                  {confirmDelete === w.boxId ? (
                    <>
                      <button
                        type="button"
                        data-testid="feedback-widget-delete-confirm"
                        disabled={busy}
                        onClick={() => void onDelete(w)}
                        className="rounded border border-red-500/60 px-2 py-0.5 text-[12px] text-red-400 hover:bg-bg-hover disabled:opacity-50"
                      >
                        Delete for good
                      </button>
                      <button
                        type="button"
                        data-testid="feedback-widget-delete-cancel"
                        onClick={() => setConfirmDelete(null)}
                        className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="feedback-widget-delete"
                      disabled={busy}
                      onClick={() => setConfirmDelete(w.boxId)}
                      className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover disabled:opacity-50"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {snippet && (
        <div data-testid="feedback-widget-snippet-box" className="flex flex-col gap-1">
          <span className="text-[12px] text-fg-dim">Paste this line into your site&apos;s HTML:</span>
          <div className="flex items-start gap-2">
            <pre
              data-testid="feedback-widget-snippet"
              className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-bg-hover p-2 font-mono text-[11.5px]"
            >
              {snippet}
            </pre>
            <button
              type="button"
              data-testid="feedback-widget-snippet-copy"
              onClick={() => void copy(snippet)}
              className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      <form
        data-testid="feedback-widget-create"
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void onCreate()
        }}
      >
        <span className="text-[12.5px] font-medium">New widget</span>
        <label className="flex flex-col gap-1 text-[12px] text-fg-dim">
          Label
          <input
            data-testid="feedback-widget-label-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={200}
            className="rounded border border-line bg-transparent px-2 py-1 text-[12.5px] text-fg"
          />
          {errors.label && (
            <span data-testid="feedback-widget-label-error" className="text-[11.5px] text-red-400">
              {errors.label}
            </span>
          )}
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-fg-dim">
          Allowed sites (one per line)
          <textarea
            data-testid="feedback-widget-sites-input"
            value={sitesText}
            onChange={(e) => setSitesText(e.target.value)}
            rows={3}
            placeholder={'https://example.com\nhttp://localhost:3000'}
            className="rounded border border-line bg-transparent px-2 py-1 font-mono text-[12px] text-fg"
          />
          {errors.sites && (
            <span data-testid="feedback-widget-sites-error" className="text-[11.5px] text-red-400">
              {errors.sites}
            </span>
          )}
        </label>
        <div>
          <button
            type="submit"
            data-testid="feedback-widget-create-submit"
            disabled={creating}
            className="rounded border border-line px-2.5 py-1 text-[12.5px] hover:bg-bg-hover disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create widget'}
          </button>
        </div>
      </form>
    </div>
  )
}
