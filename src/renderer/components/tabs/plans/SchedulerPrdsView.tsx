import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScheduleStateSnapshot } from '../../../../preload/api'
import { ListDetail } from '../../ui/ListDetail'
import { EmptyState } from '../../ui/EmptyState'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { Tooltip } from '../../ui/Tooltip'

type PrdStatus = 'pending' | 'running' | 'completed' | 'failed' | 'unqueued'

interface PrdMeta {
  slug: string
  parallelGroup: number
  title: string
  cwd: string
  estimateMinutes: number | null
  mtimeMs: number
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw }
  const end = raw.indexOf('\n---\n', 4)
  if (end === -1) return { frontmatter: {}, body: raw }
  const fm: Record<string, string> = {}
  for (const line of raw.slice(4, end).split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return { frontmatter: fm, body: raw.slice(end + 5) }
}

function validateDraft(draft: string): string | null {
  const { frontmatter: fm } = splitFrontmatter(draft)
  if (!fm.title?.trim()) return 'frontmatter "title" is required'
  if (!fm.cwd?.trim()) return 'frontmatter "cwd" is required'
  if (fm.estimateMinutes !== undefined) {
    const v = Number(fm.estimateMinutes)
    if (!Number.isInteger(v) || v <= 0) return '"estimateMinutes" must be a positive integer'
  }
  return null
}

function StatusPill({ status }: { status: PrdStatus }) {
  const base = 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono border'
  const cls: Record<PrdStatus, string> = {
    pending: `${base} text-fg-dim border-line`,
    running: `${base} text-amber-400 border-amber-400/50`,
    completed: `${base} text-green-400 border-green-400/50`,
    failed: `${base} text-red-400 border-red-400/50`,
    unqueued: `${base} text-fg-faint border-dashed border-line`,
  }
  return (
    <span className={cls[status]}>
      {status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      )}
      {status}
    </span>
  )
}

function TBtn({
  label,
  tip,
  onClick,
  disabled,
  primary,
}: {
  label: string
  tip: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <Tooltip content={tip} align="bottom-center">
      <button
        title={tip}
        onClick={onClick}
        disabled={disabled}
        className={`px-2 py-0.5 text-xs rounded border disabled:opacity-40 disabled:cursor-not-allowed ${
          primary
            ? 'text-accent border-accent/50 hover:bg-bg-hi'
            : 'text-fg-dim border-line hover:text-fg hover:bg-bg-hi'
        }`}
      >
        {label}
      </button>
    </Tooltip>
  )
}

function FmRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-fg-faint">{label}</span>
      <span className="text-fg-dim min-w-0 break-all">{children}</span>
    </div>
  )
}

export function SchedulerPrdsView() {
  const [prds, setPrds] = useState<PrdMeta[]>([])
  const [queueState, setQueueState] = useState<ScheduleStateSnapshot | null>(null)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [logText, setLogText] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    window.api.schedule
      .listPrds()
      .then((list) => {
        if (alive) {
          setPrds(list)
          setLoading(false)
        }
      })
      .catch(() => {
        if (alive) setLoading(false)
      })
    window.api.schedule
      .state()
      .then((s) => {
        if (alive) setQueueState(s)
      })
      .catch(() => {})
    const off = window.api.schedule.onState((s) => {
      if (alive) setQueueState(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // Auto-select first PRD on initial load
  useEffect(() => {
    if (!selectedSlug && prds.length > 0) setSelectedSlug(prds[0].slug)
  }, [prds, selectedSlug])

  // Load body when selection changes
  useEffect(() => {
    if (!selectedSlug) return
    let alive = true
    window.api.schedule
      .readPrd(selectedSlug)
      .then((res) => {
        if (!alive) return
        const text = res.ok && res.text != null ? res.text : ''
        setBody(text)
        setDraft(text)
        setEditing(false)
        setSaveError(null)
        setLogText(null)
        setShowLog(false)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [selectedSlug])

  const job = useMemo(
    () => queueState?.jobs.find((j) => j.slug === selectedSlug) ?? null,
    [queueState, selectedSlug],
  )
  const status: PrdStatus = job == null ? 'unqueued' : (job.status as PrdStatus)

  const { frontmatter: fm, body: mdBody } = useMemo(() => splitFrontmatter(body), [body])

  async function handleSave() {
    if (!selectedSlug) return
    const err = validateDraft(draft)
    if (err) {
      setSaveError(err)
      return
    }
    setSaveError(null)
    try {
      await window.api.schedule.writePrd(selectedSlug, draft)
      setBody(draft)
      setEditing(false)
      const list = await window.api.schedule.listPrds()
      setPrds(list)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleShowLog() {
    if (!selectedSlug) return
    if (!job?.runId) {
      setLogText('no log available (job has not run yet)')
      setShowLog((v) => !v)
      return
    }
    const res = await window.api.schedule.readLog(job.runId, selectedSlug)
    setLogText(res.ok ? (res.text ?? '') : `error: ${res.error}`)
    setShowLog((v) => !v)
  }

  function selectSlug(slug: string) {
    setSelectedSlug(slug)
    setEditing(false)
    setSaveError(null)
  }

  if (loading) return <EmptyState title="loading PRDs…" />

  const sidebar = (
    <div className="py-2">
      {prds.length === 0 ? (
        <div className="px-3 py-2 text-xs text-fg-faint">no PRDs found</div>
      ) : (
        prds.map((p) => {
          const j = queueState?.jobs.find((jj) => jj.slug === p.slug)
          const s: PrdStatus = j == null ? 'unqueued' : (j.status as PrdStatus)
          const sel = p.slug === selectedSlug
          return (
            <button
              key={p.slug}
              onClick={() => selectSlug(p.slug)}
              className={`w-full text-left px-3 py-2 border-l-2 ${
                sel ? 'bg-bg-hi border-accent' : 'border-transparent hover:bg-bg-hi'
              }`}
            >
              <div className="font-mono text-[11px] text-fg truncate">{p.slug}</div>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                <StatusPill status={s} />
                {p.estimateMinutes != null && (
                  <span className="text-[10px] text-fg-faint">{p.estimateMinutes}m</span>
                )}
                <span className="text-[10px] text-fg-faint">g{p.parallelGroup}</span>
              </div>
            </button>
          )
        })
      )}
    </div>
  )

  const detail =
    selectedSlug == null ? (
      <EmptyState title="select a PRD" />
    ) : (
      <div>
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
          <StatusPill status={status} />
          <div className="flex-1" />
          {editing ? (
            <>
              <TBtn label="Save" tip="Save PRD to disk" onClick={handleSave} primary />
              <TBtn
                label="Cancel"
                tip="Discard edits"
                onClick={() => {
                  setDraft(body)
                  setEditing(false)
                  setSaveError(null)
                }}
              />
            </>
          ) : (
            <TBtn
              label="Edit"
              tip="Edit this PRD"
              onClick={() => {
                setEditing(true)
                setSaveError(null)
              }}
            />
          )}
          <TBtn
            label="Reset"
            tip="Reset failed job to pending"
            onClick={() => {
              window.api.schedule.resetJob(selectedSlug)
            }}
            disabled={status !== 'failed'}
          />
          <TBtn
            label="Run now"
            tip="Run all pending jobs immediately"
            onClick={() => {
              window.api.schedule.runNow()
            }}
          />
          <TBtn
            label="Open folder"
            tip="Open PRDs folder in file manager"
            onClick={() => {
              window.api.schedule.openFolder()
            }}
          />
          <TBtn
            label={showLog ? 'Hide log' : 'Last run log'}
            tip="Toggle most recent run log"
            onClick={handleShowLog}
          />
        </div>

        {/* Save error banner */}
        {saveError && (
          <div className="px-3 py-2 text-xs text-red-300 bg-red-900/20 border-b border-red-400/30">
            {saveError}
          </div>
        )}

        {/* Content */}
        {editing ? (
          <div style={{ height: '600px' }}>
            <MarkdownEditor
              value={draft}
              onChange={setDraft}
              path={`/scheduler/prds/${selectedSlug}.md`}
            />
          </div>
        ) : (
          <div className="p-4 max-w-3xl space-y-4">
            {/* Frontmatter card */}
            <div className="p-3 rounded border border-line bg-bg-elev text-xs space-y-1">
              <FmRow label="title">{fm.title || '—'}</FmRow>
              <FmRow label="cwd">
                <span className="font-mono">{fm.cwd || '—'}</span>
              </FmRow>
              {fm.estimateMinutes && (
                <FmRow label="estimateMinutes">{fm.estimateMinutes}</FmRow>
              )}
              {fm.parallelGroup && <FmRow label="parallelGroup">{fm.parallelGroup}</FmRow>}
              <FmRow label="queued status">{status}</FmRow>
              {job?.finishedAt && (
                <FmRow label="last run">{new Date(job.finishedAt).toLocaleString()}</FmRow>
              )}
            </div>

            {/* Body — raw markdown (MarkdownEditor is Monaco, not a renderer) */}
            <div>
              <span className="text-[9px] text-fg-faint uppercase tracking-wide">raw</span>
              <pre className="mt-1 text-xs text-fg-dim whitespace-pre-wrap font-mono leading-5">
                {mdBody || <span className="italic">empty body</span>}
              </pre>
            </div>
          </div>
        )}

        {/* Log panel */}
        {showLog && logText !== null && (
          <div className="border-t border-line max-h-64 overflow-auto bg-bg-elev">
            <div className="px-3 py-1.5 flex items-center gap-2 border-b border-line sticky top-0 bg-bg-elev">
              <span className="text-[10px] text-fg-faint font-mono">
                run log{job?.runId ? ` — ${job.runId}` : ''}
              </span>
              <button
                onClick={() => setShowLog(false)}
                className="ml-auto text-[10px] text-fg-faint hover:text-fg"
              >
                close
              </button>
            </div>
            <pre className="p-3 text-[11px] font-mono text-fg-dim whitespace-pre-wrap">
              {logText}
            </pre>
          </div>
        )}
      </div>
    )

  return <ListDetail sidebar={sidebar} detail={detail} sidebarWidth="14rem" />
}
