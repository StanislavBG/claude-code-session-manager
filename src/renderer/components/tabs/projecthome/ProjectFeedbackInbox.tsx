/**
 * ProjectFeedbackInbox — Project Home ▸ Feedback ▸ Inbox: every website report this project's
 * widgets delivered, read in full.
 *
 * List: type dot, title, reporter (signed id + email with a 'Verified' / 'claimed by site' /
 * 'signature did not match' badge from meta.reporterVerified, then the name labelled 'name as
 * given by the site' — the signature never covers it — or 'Anonymous'), page host, age, status —
 * newest first, with a status filter (reloads through the store's loadItems). Detail: the
 * annotated screenshot (toggle to the raw one) loaded through window.api.siteFeedback.inboxImage,
 * a marks table, details, page URL + viewport, and collapsible console / network lists; status
 * can be set and the report removed after a confirm. "Open as Epic" is a human press through the
 * New Epic mint path (createPromptSession — born proposed), built by lib/siteFeedbackIntake.ts with
 * every visitor-supplied part fenced as data; it then links the Epic and sets in_progress. The
 * created Epic id is kept in the site feedback store (pendingEpicByItem) once the mint succeeds, so it survives close/reopen: a failed link offers 'Retry link' for that same
 * Epic and the press never mints a second one.
 *
 * Every report field is visitor-supplied: it renders only as React text children — no
 * dangerouslySetInnerHTML, no auto-linking (the page URL is text, never an <a>).
 * Failures go to the toast channel; the store also keeps them as the cwd's `error`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { selectPendingEpic, selectSiteFeedback, useSiteFeedback } from '../../../state/siteFeedback'
import { toast, useToast } from '../../../state/toast'
import { usePromptSessions } from '../../../state/promptSessions'
import { buildSiteIntake } from '../../../lib/siteFeedbackIntake'
import { formatAgo } from '../../../lib/formatTime'
import type {
  SiteFeedbackImageKind,
  SiteFeedbackInboxItem,
  SiteFeedbackItemDetail,
  SiteFeedbackMark,
  SiteFeedbackResult,
  SiteFeedbackStatus,
} from '../../../../preload/api'

export const SITE_STATUSES: { value: SiteFeedbackStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'wontfix', label: "Won't fix" },
]
const STATUS_LABEL: Record<string, string> = Object.fromEntries(SITE_STATUSES.map((s) => [s.value, s.label]))

const TYPE_DOT: Record<string, string> = { bug: 'bg-red-500', feature: 'bg-amber-400', other: 'bg-fg-faint' }

function toastFailure<T>(r: SiteFeedbackResult<T>): SiteFeedbackResult<T> {
  if (!r.ok) toast.error(`Feedback: ${r.message || r.error}`)
  return r
}

const toMs = (iso: string): number => {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** Host of a URL/origin; the raw string when it does not parse. */
export function pageHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

type ReporterLike = { id: string; name?: string | null; email?: string | null } | null

/** Badge text for meta.reporterVerified: true 'Verified', false 'signature did not match', else 'claimed by site'. */
export function reporterBadge(verified: boolean | null | undefined): string {
  if (verified === true) return 'Verified'
  if (verified === false) return 'signature did not match'
  return 'claimed by site'
}

export const SITE_GIVEN_NAME = 'name as given by the site'

/** The signed part of a reporter (id and email — the signature covers these, never the name). */
function signedPart(reporter: NonNullable<ReporterLike>): string {
  return [reporter.id, reporter.email].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' · ')
}

/**
 * '<id> · <email> · <badge> · <name> (name as given by the site)' for a reporter, else
 * 'Anonymous'. The badge sits next to the signed id/email only; the name is never verified.
 */
export function reporterLabel(reporter: ReporterLike, verified?: boolean | null): string {
  if (!reporter) return 'Anonymous'
  return [
    signedPart(reporter),
    reporterBadge(verified),
    reporter.name ? `${reporter.name} (${SITE_GIVEN_NAME})` : '',
  ].filter((part) => part.length > 0).join(' · ')
}

/** The reporter as text plus a badge span; textContent equals reporterLabel(). */
function Reporter({ reporter, verified }: { reporter: ReporterLike; verified: boolean | null | undefined }) {
  if (!reporter) return <>Anonymous</>
  const state = verified === true ? 'verified' : verified === false ? 'mismatch' : 'claimed'
  const tone = verified === true
    ? 'border-sage text-sage-dark'
    : verified === false
      ? 'border-accent text-accent-dark'
      : 'border-line text-fg-dim'
  const signed = signedPart(reporter)
  return (
    <>
      {signed ? (
        <>
          <span data-testid="site-feedback-reporter-signed">{signed}</span>
          {' · '}
        </>
      ) : null}
      <span
        data-testid="site-feedback-reporter-badge"
        data-verified={state}
        className={`rounded border px-1 text-[10.5px] ${tone}`}
      >
        {reporterBadge(verified)}
      </span>
      {reporter.name ? (
        <>
          {' · '}
          <span data-testid="site-feedback-reporter-name" title={`Not covered by the signature — ${SITE_GIVEN_NAME}`}>
            {reporter.name} ({SITE_GIVEN_NAME})
          </span>
        </>
      ) : null}
    </>
  )
}

function TypeDot({ type }: { type: string }) {
  return (
    <span
      data-testid="site-feedback-type-dot"
      data-type={type}
      title={type}
      aria-label={type}
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${TYPE_DOT[type] ?? TYPE_DOT.other}`}
    />
  )
}

type ImgState = { status: 'loading' } | { status: 'ok'; dataUrl: string } | { status: 'error'; message: string } | { status: 'none' }

function Screenshot({ cwd, detail }: { cwd: string; detail: SiteFeedbackItemDetail }) {
  const hostId = detail.meta.hostId
  const hasAnnotated = detail.imagePaths.annotated != null
  const hasRaw = detail.imagePaths.screenshot != null
  const [which, setWhich] = useState<SiteFeedbackImageKind>(hasAnnotated ? 'annotated' : 'screenshot')
  const [img, setImg] = useState<ImgState>({ status: 'loading' })
  const available = which === 'annotated' ? hasAnnotated : hasRaw

  useEffect(() => {
    if (!available) {
      setImg({ status: 'none' })
      return
    }
    let cancelled = false
    setImg({ status: 'loading' })
    Promise.resolve()
      .then(() => window.api.siteFeedback.inboxImage({ cwd, hostId, which }))
      .then(
        (r) => {
          if (cancelled) return
          setImg(r.ok ? { status: 'ok', dataUrl: r.dataUrl } : { status: 'error', message: r.message || r.error })
        },
        (e: unknown) => {
          if (!cancelled) setImg({ status: 'error', message: e instanceof Error ? e.message : String(e) })
        },
      )
    return () => {
      cancelled = true
    }
  }, [cwd, hostId, which, available])

  return (
    <div data-testid="site-feedback-screenshot" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[12px]">
        {(['annotated', 'screenshot'] as const).map((k) => (
          <button
            key={k}
            type="button"
            data-testid={`site-feedback-shot-${k}`}
            aria-pressed={which === k}
            onClick={() => setWhich(k)}
            className={`rounded border px-2 py-0.5 ${which === k ? 'border-accent text-fg' : 'border-line text-fg-dim hover:bg-bg-hover'}`}
          >
            {k === 'annotated' ? 'Annotated' : 'Raw'}
          </button>
        ))}
      </div>
      {img.status === 'ok' ? (
        <img
          data-testid="site-feedback-screenshot-img"
          data-which={which}
          src={img.dataUrl}
          alt={which === 'annotated' ? 'Annotated screenshot' : 'Raw screenshot'}
          className="max-h-[480px] max-w-full self-start rounded border border-line object-contain"
        />
      ) : (
        <div data-testid="site-feedback-screenshot-state" className="text-[12px] text-fg-dim">
          {img.status === 'loading'
            ? 'Loading screenshot…'
            : img.status === 'none'
              ? `No ${which === 'annotated' ? 'annotated' : 'raw'} screenshot`
              : `Could not load screenshot: ${img.message}`}
        </div>
      )}
    </div>
  )
}

function markRow(m: SiteFeedbackMark): { n: string; kind: string; selector: string; note: string } {
  switch (m.kind) {
    case 'pin':
    case 'box':
      return { n: String(m.n), kind: m.kind, selector: '—', note: m.note }
    case 'element':
      return { n: String(m.n), kind: m.kind, selector: m.element.selector, note: m.note }
    case 'text':
      return { n: '—', kind: m.kind, selector: '—', note: m.text }
    default:
      return { n: '—', kind: m.kind, selector: '—', note: '' }
  }
}

function Marks({ marks }: { marks: SiteFeedbackMark[] }) {
  if (marks.length === 0) return <p className="text-[12px] text-fg-dim">No marks</p>
  return (
    <table data-testid="site-feedback-marks" className="w-full border-collapse text-left text-[12px]">
      <thead className="text-fg-faint">
        <tr>
          <th className="py-1 pr-2 font-medium">n</th>
          <th className="py-1 pr-2 font-medium">Kind</th>
          <th className="py-1 pr-2 font-medium">Selector</th>
          <th className="py-1 font-medium">Note</th>
        </tr>
      </thead>
      <tbody>
        {marks.map((m, i) => {
          const r = markRow(m)
          return (
            <tr key={i} data-testid="site-feedback-mark" className="border-t border-line align-top">
              <td className="py-1 pr-2 font-mono">{r.n}</td>
              <td className="py-1 pr-2">{r.kind}</td>
              <td className="break-all py-1 pr-2 font-mono">{r.selector}</td>
              <td className="whitespace-pre-wrap break-words py-1">{r.note}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Detail({ cwd, detail }: { cwd: string; detail: SiteFeedbackItemDetail }) {
  const setStatus = useSiteFeedback((s) => s.setStatus)
  const removeItem = useSiteFeedback((s) => s.removeItem)
  const closeItem = useSiteFeedback((s) => s.closeItem)
  const linkEpic = useSiteFeedback((s) => s.linkEpic)
  const createPromptSession = usePromptSessions((s) => s.createPromptSession)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const { meta, report } = detail

  const onStatus = async (status: SiteFeedbackStatus) => {
    setBusy(true)
    try {
      toastFailure(await setStatus(cwd, meta.hostId, status))
    } finally {
      setBusy(false)
    }
  }
  const linked = meta.epicId != null
  // The Epic minted for THIS report, kept in the store (survives close/reopen) so a failed
  // link is retried, never re-minted.
  const mintedEpicId = useSiteFeedback(selectPendingEpic(cwd, meta.hostId))
  const setPendingEpic = useSiteFeedback((s) => s.setPendingEpic)
  const inFlight = useRef(false)
  const showToast = (msg: string) => useToast.getState().show('error', msg)

  const linkAndStart = async (epicId: string) => {
    const link = await linkEpic(cwd, meta.hostId, epicId)
    if (!link.ok) {
      showToast(`Feedback: Epic created but not linked — ${link.message || link.error}. Use Retry link.`)
      return
    }
    toastFailure(await setStatus(cwd, meta.hostId, 'in_progress'))
  }
  const press = async (run: () => Promise<void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      await run()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  const onOpenAsEpic = () =>
    press(async () => {
      if (linked || mintedEpicId) return
      const { goalText, openingPrompt, sections, tag } = await buildSiteIntake(detail, cwd)
      const session = await createPromptSession(cwd, goalText, tag, undefined, 'architect', openingPrompt, sections)
      setPendingEpic(cwd, meta.hostId, session.id)
      await linkAndStart(session.id)
    })
  const onRetryLink = () =>
    press(async () => {
      if (linked || !mintedEpicId) return
      await linkAndStart(mintedEpicId)
    })
  const onRemove = async () => {
    setConfirmRemove(false)
    setBusy(true)
    try {
      toastFailure(await removeItem(cwd, meta.hostId))
    } finally {
      setBusy(false)
    }
  }

  const vp = report?.page.viewport
  return (
    <div data-testid="site-feedback-detail" data-host-id={meta.hostId} className="flex flex-col gap-3 rounded-lg border border-line bg-bg px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {report && <TypeDot type={report.type} />}
          <h3 data-testid="site-feedback-detail-title" className="min-w-0 break-words text-[14px] font-semibold">
            {report ? report.title : meta.hostId}
          </h3>
        </div>
        <button
          type="button"
          data-testid="site-feedback-detail-close"
          onClick={() => closeItem(cwd)}
          className="shrink-0 rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover"
        >
          Close
        </button>
      </div>
      <div className="font-mono text-[11px] text-fg-dim">
        {meta.hostId} · <Reporter reporter={report ? report.user : null} verified={meta.reporterVerified} /> · received {new Date(toMs(meta.receivedAt)).toLocaleString()}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={meta.status}
          disabled={busy}
          onChange={(e) => void onStatus(e.target.value as SiteFeedbackStatus)}
          aria-label="Status"
          data-testid="site-feedback-detail-status"
          className="rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg"
        >
          {SITE_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="site-feedback-open-epic"
          disabled={busy || linked || mintedEpicId != null}
          title={
            linked
              ? 'An Epic is already linked to this report'
              : mintedEpicId
                ? 'An Epic was created for this report — use Retry link'
                : 'Create a proposed Epic from this report'
          }
          onClick={() => void onOpenAsEpic()}
          className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover disabled:opacity-50"
        >
          Open as Epic
        </button>
        {mintedEpicId && !linked && (
          <button
            type="button"
            data-testid="site-feedback-retry-link"
            disabled={busy}
            title="Link the Epic already created for this report"
            onClick={() => void onRetryLink()}
            className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover disabled:opacity-50"
          >
            Retry link
          </button>
        )}
        {confirmRemove ? (
          <>
            <button
              type="button"
              data-testid="site-feedback-remove-confirm"
              disabled={busy}
              onClick={() => void onRemove()}
              className="rounded border border-red-500/60 px-2 py-0.5 text-[12px] text-red-400 hover:bg-bg-hover disabled:opacity-50"
            >
              Remove for good
            </button>
            <button
              type="button"
              data-testid="site-feedback-remove-cancel"
              onClick={() => setConfirmRemove(false)}
              className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="site-feedback-remove"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
            className="rounded border border-line px-2 py-0.5 text-[12px] hover:bg-bg-hover disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
      {!report ? (
        <p data-testid="site-feedback-detail-unreadable" className="text-[12px] text-fg-dim">
          This report could not be read.
        </p>
      ) : (
        <>
          <Screenshot key={meta.hostId} cwd={cwd} detail={detail} />
          <section className="flex flex-col gap-1">
            <h4 className="text-[12px] font-semibold text-fg-dim">Marks</h4>
            <Marks marks={report.marks} />
          </section>
          <section className="flex flex-col gap-1">
            <h4 className="text-[12px] font-semibold text-fg-dim">Details</h4>
            <p data-testid="site-feedback-details" className="whitespace-pre-wrap break-words text-[12.5px]">
              {report.details || '—'}
            </p>
          </section>
          <section className="flex flex-col gap-1">
            <h4 className="text-[12px] font-semibold text-fg-dim">Page</h4>
            <div data-testid="site-feedback-page-url" className="break-all font-mono text-[12px]">
              {report.page.url}
            </div>
            {report.page.title && <div className="text-[12px] text-fg-dim">{report.page.title}</div>}
            {vp && (
              <div data-testid="site-feedback-viewport" className="font-mono text-[12px] text-fg-dim">
                {vp.width} × {vp.height} @ {vp.devicePixelRatio}x · scroll {vp.scrollX},{vp.scrollY}
              </div>
            )}
          </section>
          <details data-testid="site-feedback-console" className="text-[12px]">
            <summary className="cursor-pointer font-semibold text-fg-dim">
              Console errors ({report.console ? report.console.length : 'not captured'})
            </summary>
            {report.console && report.console.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1">
                {report.console.map((c, i) => (
                  <li key={i} data-testid="site-feedback-console-entry" className="rounded border border-line px-2 py-1 font-mono">
                    <div className="whitespace-pre-wrap break-words">
                      {c.message}
                      {c.count > 1 ? ` ×${c.count}` : ''}
                    </div>
                    {c.source && <div className="break-all text-fg-dim">{c.source}</div>}
                    {c.stack && <pre className="whitespace-pre-wrap break-words text-fg-dim">{c.stack}</pre>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-fg-dim">{report.console ? 'No console errors' : 'Console was not captured'}</p>
            )}
          </details>
          <details data-testid="site-feedback-network" className="text-[12px]">
            <summary className="cursor-pointer font-semibold text-fg-dim">
              Failed requests ({report.network ? report.network.length : 'not captured'})
            </summary>
            {report.network && report.network.length > 0 ? (
              <ul className="mt-1 flex flex-col gap-1">
                {report.network.map((n, i) => (
                  <li key={i} data-testid="site-feedback-network-entry" className="break-all rounded border border-line px-2 py-1 font-mono">
                    {n.method} {n.url} → {String(n.status)} · {n.durationMs} ms
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-fg-dim">{report.network ? 'No failed requests' : 'Network was not captured'}</p>
            )}
          </details>
        </>
      )}
    </div>
  )
}

export function ProjectFeedbackInbox({ cwd }: { cwd: string }) {
  const state = useSiteFeedback(selectSiteFeedback(cwd))
  const loadItems = useSiteFeedback((s) => s.loadItems)
  const openItem = useSiteFeedback((s) => s.openItem)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const items = state.items
  const sorted = useMemo(() => [...items].sort((a, b) => toMs(b.receivedAt) - toMs(a.receivedAt)), [items])

  const onFilter = (v: string) => {
    void loadItems(cwd, v === '' ? undefined : (v as SiteFeedbackStatus)).then(toastFailure)
  }
  const onOpen = (hostId: string) => {
    void openItem(cwd, hostId).then(toastFailure)
  }

  return (
    <div data-testid="site-feedback-inbox" className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-[12px] text-fg-dim">
        Status
        <select
          value={state.statusFilter ?? ''}
          onChange={(e) => onFilter(e.target.value)}
          data-testid="site-feedback-filter"
          aria-label="Status filter"
          className="rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg"
        >
          <option value="">All</option>
          {SITE_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      {sorted.length > 0 && (
        <ul data-testid="site-feedback-list" className="flex flex-col gap-1">
          {sorted.map((it) => (
            <li key={it.hostId}>
              <button
                type="button"
                data-testid="site-feedback-row"
                data-host-id={it.hostId}
                aria-pressed={state.selectedHostId === it.hostId}
                onClick={() => onOpen(it.hostId)}
                className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-[12.5px] hover:bg-bg-hover ${
                  state.selectedHostId === it.hostId ? 'border-accent' : 'border-line'
                }`}
              >
                <TypeDot type={it.type} />
                <span data-testid="site-feedback-row-title" className="min-w-0 flex-1 truncate font-medium">
                  {it.title}
                </span>
                <span data-testid="site-feedback-row-reporter" className="shrink-0 text-[11.5px] text-fg-dim">
                  <Reporter reporter={it.reporter} verified={it.reporterVerified} />
                </span>
                <span data-testid="site-feedback-row-host" className="shrink-0 font-mono text-[11px] text-fg-dim">
                  {pageHost(it.origin)}
                </span>
                <span data-testid="site-feedback-row-age" className="shrink-0 font-mono text-[11px] text-fg-faint">
                  {formatAgo(toMs(it.receivedAt), now)}
                </span>
                <span
                  data-testid="site-feedback-row-status"
                  className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[11px] font-semibold text-fg-dim"
                >
                  {STATUS_LABEL[it.status] ?? it.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.selectedHostId &&
        (state.selected ? (
          <Detail cwd={cwd} detail={state.selected} />
        ) : (
          <p data-testid="site-feedback-detail-loading" className="text-[12px] text-fg-dim">
            {state.itemLoading ? 'Loading report…' : 'Could not load this report'}
          </p>
        ))}
    </div>
  )
}
