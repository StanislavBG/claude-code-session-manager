import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScheduleStateSnapshot, RetagPrdItem, LintFinding } from '../../../../preload/api'
import { ListDetail } from '../../ui/ListDetail'
import { EmptyState } from '../../ui/EmptyState'
import { MarkdownEditor } from '../../ui/MarkdownEditor'
import { Modal } from '../../ui/Modal'
import { Tooltip } from '../../ui/Tooltip'
import { parsePrdFile, serializePrdFile, type PrdFrontmatter } from '../../../lib/prdFrontmatter'
import { toast } from '../../../state/toast'
import { useScheduleState } from '../../../state/scheduleState'
import { getLintQueueCached } from '../../../lib/lintQueueCache'
import { StatusBadge } from '../../ui/StatusBadge'
import type { JobStatus } from '../../ui/StatusBadge'

function projectTag(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const segs = cwd.replace(/\/+$/, '').split('/')
  return segs[segs.length - 1] || cwd
}

// ─── Real-time PRD linting ───────────────────────────────────────────────────

// Mirrors the LINE_RULES in queueOps.cjs for instant client-side feedback.
const CLIENT_LINT_RULES: Array<{ id: string; re: RegExp; severity: 'warn' | 'error'; label: string }> = [
  { id: 'unbounded-until', re: /^\s*until\s+/, severity: 'error', label: '"until" loop — risk of unbounded poll' },
  { id: 'while-true',      re: /^\s*while\s+(?:true|:)/i, severity: 'error', label: '"while true" — unbounded loop' },
  { id: 'unbounded-seq',   re: /for\s+\S+\s+in\s+\$\(seq\s+1\s+[5-9][0-9]{2,}/, severity: 'error', label: 'unbounded seq — range ≥500' },
  { id: 'no-verify',       re: /--no-verify\b/, severity: 'warn', label: '--no-verify — skips git hooks' },
  { id: 'no-gpg-sign',     re: /--no-gpg-sign\b/, severity: 'warn', label: '--no-gpg-sign — bypasses signing' },
]

function lintPrdText(text: string): LintFinding[] {
  const findings: LintFinding[] = []

  // Frontmatter validation
  const { frontmatter: fm } = parsePrdFile(text)
  if (!fm.title?.trim()) {
    findings.push({ rule: 'missing-title', line: 1, snippet: 'frontmatter "title" is required', severity: 'error' })
  }
  if (!fm.cwd?.trim()) {
    findings.push({ rule: 'missing-cwd', line: 1, snippet: 'frontmatter "cwd" is required', severity: 'error' })
  }
  if (fm.estimateMinutes !== undefined && (!Number.isInteger(fm.estimateMinutes) || fm.estimateMinutes <= 0)) {
    findings.push({ rule: 'invalid-estimate', line: 1, snippet: '"estimateMinutes" must be a positive integer', severity: 'error' })
  }

  // Line-by-line loop/flag detection
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const rule of CLIENT_LINT_RULES) {
      if (rule.re.test(line)) {
        findings.push({
          rule: rule.id,
          line: i + 1,
          snippet: line.trim().slice(0, 80),
          severity: rule.severity,
        })
      }
    }
  }

  return findings
}

/** Debounced real-time linting of the current PRD draft. */
function useLintPrd(text: string): { findings: LintFinding[] } {
  const [findings, setFindings] = useState<LintFinding[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setFindings(lintPrdText(text))
    }, 300)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [text])

  return { findings }
}

function LintPanel({ findings }: { findings: LintFinding[] }) {
  if (findings.length === 0) return null
  const errors = findings.filter((f) => f.severity === 'error')
  const warns = findings.filter((f) => f.severity === 'warn')
  return (
    <div className="mx-4 mt-2 mb-1 p-3 rounded border border-amber-400/30 bg-amber-950/10 text-xs space-y-1" role="alert">
      <div className="text-[10px] uppercase tracking-wide text-amber-300 font-medium">
        {errors.length > 0 && `${errors.length} error${errors.length !== 1 ? 's' : ''}`}
        {errors.length > 0 && warns.length > 0 && ' · '}
        {warns.length > 0 && `${warns.length} warning${warns.length !== 1 ? 's' : ''}`}
      </div>
      {findings.map((f, idx) => (
        <div key={idx} className="font-mono text-[11px] flex gap-2 items-baseline">
          <span className={`shrink-0 ${f.severity === 'error' ? 'text-red-300' : 'text-amber-300'}`}>
            {f.severity === 'error' ? '✗' : '⚠'} L{f.line}
          </span>
          <span className="text-fg-faint truncate">{f.rule}: {f.snippet}</span>
        </div>
      ))}
    </div>
  )
}

type PrdStatus = JobStatus

interface PrdMeta {
  slug: string
  parallelGroup: number
  title: string
  cwd: string
  estimateMinutes: number | null
  mtimeMs: number
}

function validateDraft(draft: string): string | null {
  const { frontmatter: fm } = parsePrdFile(draft)
  if (!fm.title?.trim()) return 'frontmatter "title" is required'
  if (!fm.cwd?.trim()) return 'frontmatter "cwd" is required'
  if (fm.estimateMinutes !== undefined) {
    if (!Number.isInteger(fm.estimateMinutes) || fm.estimateMinutes <= 0) {
      return '"estimateMinutes" must be a positive integer'
    }
  }
  return null
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
  // Bundle E — structured editor state. `editMode` switches between the
  // structured form (default) and the raw Monaco editor (escape hatch).
  // `formFm` and `formBody` hold the in-flight structured form fields;
  // `draft` holds the raw text. Switching modes round-trips through
  // serializePrdFile / parsePrdFile so in-flight work is preserved.
  const [editMode, setEditMode] = useState<'structured' | 'raw'>('structured')
  const [formFm, setFormFm] = useState<PrdFrontmatter>({})
  const [formBody, setFormBody] = useState('')
  const [showCustomFields, setShowCustomFields] = useState(false)
  const [lintFindings, setLintFindings] = useState<LintFinding[]>([])

  // Real-time lint: derive the current "live text" from whichever edit mode is active
  const liveEditText = editing
    ? editMode === 'raw' ? draft : serializePrdFile(formFm, formBody)
    : ''
  const { findings: realtimeLintFindings } = useLintPrd(liveEditText)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [logText, setLogText] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const [loading, setLoading] = useState(true)
  // Bundle D — multi-select state. Set semantics avoid accidental O(N^2) on
  // toggle for the ~200-PRD list seen in practice.
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [retagOpen, setRetagOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)

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
      .catch((e) => {
        if (alive) {
          setLoading(false)
          toast.error(`Scheduler: failed to load PRD list — ${e instanceof Error ? e.message : 'unknown error'}`)
        }
      })
    // Schedule snapshot is owned by state/scheduleState.ts; subscribe via
    // useScheduleState() above and mirror into queueState (kept as local
    // state so existing render logic doesn't change).
    return () => {
      alive = false
    }
  }, [])

  const liveSnap = useScheduleState((s) => s.snapshot)
  useEffect(() => {
    if (liveSnap) setQueueState(liveSnap)
  }, [liveSnap])

  // Latest-addition-on-top. mtimeMs captures both new files and freshly
  // edited ones, which matches "latest" better than slug order (slugs lead
  // with the parallel group prefix, not creation order).
  const sortedPrds = useMemo(
    () => [...prds].sort((a, b) => b.mtimeMs - a.mtimeMs || a.slug.localeCompare(b.slug)),
    [prds],
  )

  // Auto-select first (= newest) PRD on initial load
  useEffect(() => {
    if (!selectedSlug && sortedPrds.length > 0) setSelectedSlug(sortedPrds[0].slug)
  }, [sortedPrds, selectedSlug])

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
        const parsed = parsePrdFile(text)
        setFormFm(parsed.frontmatter)
        setFormBody(parsed.body)
        setEditMode('structured')
        setShowCustomFields(false)
        setLintFindings([])
        setEditing(false)
        setSaveError(null)
        setLogText(null)
        setShowLog(false)
        if (!res.ok) {
          const msg = res.error ?? 'PRD read returned not-ok'
          toast.error(`Could not load PRD "${selectedSlug}": ${msg}`)
        }
      })
      .catch((e) => {
        if (!alive) return
        const msg = e instanceof Error ? e.message : String(e)
        toast.error(`Could not load PRD "${selectedSlug}": ${msg}`)
      })
    return () => {
      alive = false
    }
  }, [selectedSlug])

  const job = useMemo(
    () => queueState?.jobs.find((j) => j.slug === selectedSlug) ?? null,
    [queueState, selectedSlug],
  )
  const status: PrdStatus = job == null ? 'unqueued' : (job.status as PrdStatus)

  const { frontmatter: fm, body: mdBody } = useMemo(() => parsePrdFile(body), [body])
  const customFieldKeys = useMemo(
    () => (fm.extras ? Object.keys(fm.extras) : []),
    [fm.extras],
  )

  // Build the text that would be written. Structured-mode work is rendered
  // back to YAML via serializePrdFile; raw mode uses draft verbatim.
  function buildPayload(): string {
    if (editMode === 'raw') return draft
    return serializePrdFile(formFm, formBody)
  }

  async function runLint(forSlug: string) {
    try {
      const res = await getLintQueueCached()
      const report = res.reports.find((r) => r.slug === forSlug)
      setLintFindings(report?.findings ?? [])
    } catch {
      setLintFindings([])
    }
  }

  async function handleSave() {
    if (!selectedSlug) return
    const payload = buildPayload()
    const err = validateDraft(payload)
    if (err) {
      setSaveError(err)
      return
    }
    setSaveError(null)
    try {
      const res = await window.api.schedule.writePrd(selectedSlug, payload)
      if (!res.ok) {
        setSaveError(res.error)
        return
      }
      setBody(payload)
      setDraft(payload)
      setEditing(false)
      const list = await window.api.schedule.listPrds()
      setPrds(list)
      // Inline linter — surface findings for THIS slug inline. Runs after
      // save so the on-disk text matches what we lint.
      runLint(selectedSlug)
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
    }
  }

  // Switching modes preserves in-flight work both directions.
  function switchToRaw() {
    setDraft(serializePrdFile(formFm, formBody))
    setEditMode('raw')
  }
  function switchToStructured() {
    const parsed = parsePrdFile(draft)
    setFormFm(parsed.frontmatter)
    setFormBody(parsed.body)
    setEditMode('structured')
  }

  function beginEdit() {
    // Re-seed the form from current on-disk body so cancel-then-edit is clean.
    const parsed = parsePrdFile(body)
    setFormFm(parsed.frontmatter)
    setFormBody(parsed.body)
    setDraft(body)
    setEditMode('structured')
    setEditing(true)
    setSaveError(null)
  }

  async function pickCwd() {
    try {
      const dir = await window.api.app.pickDirectory()
      if (dir) setFormFm((prev) => ({ ...prev, cwd: dir }))
    } catch { /* user cancelled */ }
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

  // Bundle D — multi-select handlers.
  const toggleChecked = (slug: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }
  const allVisibleChecked = sortedPrds.length > 0 && sortedPrds.every((p) => checked.has(p.slug))
  const someVisibleChecked = !allVisibleChecked && sortedPrds.some((p) => checked.has(p.slug))
  const toggleAllVisible = () => {
    setChecked((prev) => {
      if (allVisibleChecked) {
        const next = new Set(prev)
        for (const p of sortedPrds) next.delete(p.slug)
        return next
      }
      const next = new Set(prev)
      for (const p of sortedPrds) next.add(p.slug)
      return next
    })
  }
  const clearChecked = () => setChecked(new Set())

  async function refreshPrds() {
    try {
      const list = await window.api.schedule.listPrds()
      setPrds(list)
    } catch { /* */ }
  }

  // Reset N pending: idempotent per-slug calls. resetJob is already
  // serialized in scheduler.cjs's mutate() so concurrency is safe.
  async function bulkReset() {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const slugs = [...checked]
      for (const slug of slugs) {
        await window.api.schedule.resetJob(slug)
      }
      clearChecked()
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  const sidebar = (
    <div className="py-2">
      {sortedPrds.length === 0 ? (
        <div className="px-3 py-2 text-xs text-fg-faint">no PRDs found</div>
      ) : (
        <>
          {/* Select-all header */}
          <label
            className="flex items-center gap-2 px-3 py-1 border-b border-line text-[10px] text-fg-faint"
            title="Select all visible PRDs"
          >
            <input
              type="checkbox"
              checked={allVisibleChecked}
              ref={(el) => { if (el) el.indeterminate = someVisibleChecked }}
              onChange={toggleAllVisible}
              className="cursor-pointer"
            />
            <span>{checked.size > 0 ? `${checked.size} selected` : `${sortedPrds.length} PRDs`}</span>
            {checked.size > 0 && (
              <button
                type="button"
                onClick={clearChecked}
                className="ml-auto text-fg-faint hover:text-fg-dim underline"
              >
                clear
              </button>
            )}
          </label>
          {sortedPrds.map((p) => {
            const j = queueState?.jobs.find((jj) => jj.slug === p.slug)
            const s: PrdStatus = j == null ? 'unqueued' : (j.status as PrdStatus)
            const sel = p.slug === selectedSlug
            const isChecked = checked.has(p.slug)
            return (
              <div
                key={p.slug}
                className={`flex items-stretch w-full border-l-2 ${
                  sel ? 'bg-bg-hi border-accent' : 'border-transparent hover:bg-bg-hi'
                }`}
              >
                <label
                  className="flex items-center px-2 cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                  title="Select for bulk action"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleChecked(p.slug)}
                    className="cursor-pointer"
                  />
                </label>
                <button
                  onClick={() => selectSlug(p.slug)}
                  className="flex-1 text-left px-1 py-2 min-w-0"
                >
                  <div className="font-mono text-[11px] text-fg truncate">{p.slug}</div>
                  <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                    <StatusBadge status={s} />
                    {projectTag(p.cwd) && (
                      <span
                        className="font-mono text-[10px] text-accent shrink-0 px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10"
                        title={`Project: ${p.cwd}`}
                      >
                        {projectTag(p.cwd)}
                      </span>
                    )}
                    {p.estimateMinutes != null && (
                      <span className="text-[10px] text-fg-faint">{p.estimateMinutes}m</span>
                    )}
                    <span className="text-[10px] text-fg-faint">g{p.parallelGroup}</span>
                  </div>
                </button>
              </div>
            )
          })}
        </>
      )}
    </div>
  )

  // Bulk action bar — rendered above the detail pane when there's a selection.
  const bulkBar = checked.size > 0 ? (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-bg-elev/60 flex-wrap">
      <span className="text-[10px] text-fg-faint font-mono">{checked.size} selected</span>
      <TBtn
        label="Reset to pending"
        tip="Reset each selected job to pending status (idempotent)"
        onClick={bulkReset}
        disabled={bulkBusy}
      />
      <TBtn
        label="Archive…"
        tip="Move selected PRD files to prds-archived/<timestamp>/ (never deletes)"
        onClick={() => setArchiveOpen(true)}
        disabled={bulkBusy}
      />
      <TBtn
        label="Retag…"
        tip="Rewrite parallelGroup and/or estimateMinutes frontmatter"
        onClick={() => setRetagOpen(true)}
        disabled={bulkBusy}
      />
      <button
        type="button"
        onClick={clearChecked}
        className="px-2 py-0.5 text-[10px] text-fg-faint hover:text-fg-dim ml-auto"
        title="Clear selection"
      >
        clear
      </button>
      {bulkError && (
        <div className="w-full text-[10px] text-red-300 mt-1">{bulkError}</div>
      )}
    </div>
  ) : null

  const detail =
    selectedSlug == null ? (
      <div>
        {bulkBar}
        <EmptyState title="select a PRD" />
      </div>
    ) : (
      <div>
        {bulkBar}
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
          <StatusBadge status={status} />
          <div className="flex-1" />
          {editing ? (
            <>
              <TBtn
                label={editMode === 'structured' ? 'View raw' : 'View structured'}
                tip={
                  editMode === 'structured'
                    ? 'Switch to raw Monaco editor (in-flight work preserved)'
                    : 'Switch back to structured form (in-flight work preserved)'
                }
                onClick={editMode === 'structured' ? switchToRaw : switchToStructured}
              />
              <TBtn label="Save" tip="Save PRD to disk" onClick={handleSave} primary />
              <TBtn
                label="Cancel"
                tip="Discard edits"
                onClick={() => {
                  setDraft(body)
                  const parsed = parsePrdFile(body)
                  setFormFm(parsed.frontmatter)
                  setFormBody(parsed.body)
                  setEditing(false)
                  setSaveError(null)
                }}
              />
            </>
          ) : (
            <TBtn label="Edit" tip="Edit this PRD" onClick={beginEdit} />
          )}
          <TBtn
            label="Reset"
            tip="Reset failed job to pending"
            onClick={() => {
              window.api.schedule.resetJob(selectedSlug)
            }}
            disabled={status !== 'failed'}
          />
          {status === 'needs_review' && (
            <TBtn
              label="Re-fire"
              tip="Reset to pending and re-queue for next scheduler run"
              onClick={() => {
                window.api.schedule.resetJob(selectedSlug)
              }}
              primary
            />
          )}
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
          <>
            {editMode === 'raw' ? (
              <div style={{ height: '600px' }}>
                <MarkdownEditor
                  value={draft}
                  onChange={setDraft}
                  path={`/scheduler/prds/${selectedSlug}.md`}
                />
              </div>
            ) : (
              <StructuredPrdEditor
                fm={formFm}
                body={formBody}
                onFmChange={setFormFm}
                onBodyChange={setFormBody}
                onPickCwd={pickCwd}
                slug={selectedSlug}
                showCustomFields={showCustomFields}
                onToggleCustomFields={() => setShowCustomFields((v) => !v)}
              />
            )}
            <LintPanel findings={realtimeLintFindings} />
          </>
        ) : (
          <div className="p-4 max-w-3xl space-y-4">
            {/* Frontmatter card */}
            <div className="p-3 rounded border border-line bg-bg-elev text-xs space-y-1">
              <FmRow label="title">{fm.title || '—'}</FmRow>
              <FmRow label="project">
                {projectTag(fm.cwd) ? (
                  <span
                    className="font-mono text-accent px-2 py-1 rounded border border-accent/30 bg-accent/10 inline-block"
                    title={`Project: ${fm.cwd}`}
                  >
                    {projectTag(fm.cwd)}
                  </span>
                ) : (
                  <span className="text-fg-faint italic">—</span>
                )}
              </FmRow>
              <FmRow label="cwd">
                <span className="font-mono">{fm.cwd || '—'}</span>
              </FmRow>
              {fm.estimateMinutes != null && (
                <FmRow label="estimateMinutes">{fm.estimateMinutes}</FmRow>
              )}
              {fm.parallelGroup != null && (
                <FmRow label="parallelGroup">{fm.parallelGroup}</FmRow>
              )}
              <FmRow label="queued status">{status}</FmRow>
              {job?.finishedAt && (
                <FmRow label="last run">{new Date(job.finishedAt).toLocaleString()}</FmRow>
              )}
              {job?.verifierVerdict && (
                <FmRow label="verifier verdict">
                  <span className="font-mono text-orange-400">{job.verifierVerdict}</span>
                </FmRow>
              )}
              {job?.verifierVerdict && job?.error && (
                <FmRow label="verdict reason">
                  <span className="font-mono text-[10px] text-fg-faint break-words">{job.error.slice(0, 160)}</span>
                </FmRow>
              )}
              {customFieldKeys.length > 0 && (
                <div className="pt-1 mt-1 border-t border-line/60">
                  <button
                    type="button"
                    onClick={() => setShowCustomFields((v) => !v)}
                    className="text-[10px] text-fg-faint hover:text-fg-dim"
                  >
                    {showCustomFields ? '▾' : '▸'} custom fields ({customFieldKeys.length})
                  </button>
                  {showCustomFields && (
                    <pre className="mt-1 text-[11px] text-fg-dim whitespace-pre-wrap font-mono leading-5">
                      {customFieldKeys
                        .map((k) => (fm.extras?.[k]?.lines ?? []).join('\n'))
                        .join('\n')}
                    </pre>
                  )}
                </div>
              )}
            </div>

            {/* Body — raw markdown (MarkdownEditor is Monaco, not a renderer) */}
            <div>
              <span className="text-[9px] text-fg-faint uppercase tracking-wide">raw</span>
              <pre className="mt-1 text-xs text-fg-dim whitespace-pre-wrap font-mono leading-5">
                {mdBody || <span className="italic">empty body</span>}
              </pre>
            </div>

            {/* Inline lint findings for THIS slug — populated after save. */}
            {lintFindings.length > 0 && (
              <div className="p-3 rounded border border-amber-400/40 bg-amber-900/10 text-xs space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-amber-300">
                  lint findings ({lintFindings.length})
                </div>
                {lintFindings.map((f, idx) => (
                  <div key={idx} className="font-mono text-[11px]">
                    <span
                      className={
                        f.severity === 'error' ? 'text-red-300' : 'text-amber-300'
                      }
                    >
                      [{f.severity}]
                    </span>{' '}
                    <span className="text-fg-faint">L{f.line}</span>{' '}
                    <span className="text-fg-dim">{f.rule}</span>
                    <div className="ml-6 text-fg-faint truncate">{f.snippet}</div>
                  </div>
                ))}
              </div>
            )}
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

  async function confirmArchive() {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const slugs = [...checked]
      const res = await window.api.schedule.archivePrds(slugs)
      if (!res.ok) {
        setBulkError(res.error ?? 'archive failed')
      } else {
        const failed = res.results?.filter((r: { ok: boolean }) => !r.ok) ?? []
        if (failed.length > 0) {
          toast.warn(`Archive: ${failed.length} of ${res.results.length} PRD${failed.length === 1 ? '' : 's'} failed to move`)
        }
        clearChecked()
        setArchiveOpen(false)
        await refreshPrds()
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  async function confirmRetag(parallelGroup: number | null, estimateMinutes: number | null) {
    setBulkBusy(true)
    setBulkError(null)
    try {
      const items: RetagPrdItem[] = []
      for (const slug of checked) {
        const item: RetagPrdItem = { slug }
        if (parallelGroup !== null) item.parallelGroup = parallelGroup
        if (estimateMinutes !== null) item.estimateMinutes = estimateMinutes
        items.push(item)
      }
      const res = await window.api.schedule.retagPrds(items)
      if (!res.ok) {
        setBulkError(res.error ?? 'retag failed')
      } else {
        clearChecked()
        setRetagOpen(false)
        await refreshPrds()
        // If the currently-selected slug was retagged with a parallelGroup
        // change, its slug may have moved; clear selection.
        if (selectedSlug && res.results.some((r) => r.slug === selectedSlug && r.newSlug && r.newSlug !== r.slug)) {
          setSelectedSlug(null)
        }
      }
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <>
      <ListDetail sidebar={sidebar} detail={detail} sidebarWidth="16rem" />
      <ArchiveConfirmModal
        open={archiveOpen}
        count={checked.size}
        busy={bulkBusy}
        onClose={() => setArchiveOpen(false)}
        onConfirm={confirmArchive}
      />
      <RetagModal
        open={retagOpen}
        count={checked.size}
        busy={bulkBusy}
        onClose={() => setRetagOpen(false)}
        onConfirm={confirmRetag}
      />
    </>
  )
}

// ─── Bundle E — structured PRD editor ──────────────────────────────────────

function StructuredPrdEditor({
  fm,
  body,
  onFmChange,
  onBodyChange,
  onPickCwd,
  slug,
  showCustomFields,
  onToggleCustomFields,
}: {
  fm: PrdFrontmatter
  body: string
  onFmChange: (next: PrdFrontmatter) => void
  onBodyChange: (next: string) => void
  onPickCwd: () => void
  slug: string
  showCustomFields: boolean
  onToggleCustomFields: () => void
}) {
  const customFieldKeys = fm.extras ? Object.keys(fm.extras) : []

  function patch(partial: Partial<PrdFrontmatter>) {
    onFmChange({ ...fm, ...partial })
  }

  // Coerce a string input into number-or-undefined. Empty string = unset.
  function num(s: string): number | undefined {
    if (s.trim() === '') return undefined
    const v = Number(s)
    return Number.isFinite(v) ? v : undefined
  }

  return (
    <div className="p-4 max-w-3xl space-y-4">
      {/* Structured frontmatter form */}
      <div className="p-3 rounded border border-line bg-bg-elev space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-fg-faint">
          frontmatter
        </div>
        <label className="flex items-start gap-2 text-xs">
          <span className="w-28 shrink-0 text-fg-faint pt-1">title*</span>
          <input
            type="text"
            value={fm.title ?? ''}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="One-line PRD title"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 text-xs"
          />
        </label>
        <label className="flex items-start gap-2 text-xs">
          <span className="w-28 shrink-0 text-fg-faint pt-1">cwd*</span>
          <div className="flex-1 flex gap-2 min-w-0">
            <input
              type="text"
              value={fm.cwd ?? ''}
              onChange={(e) => patch({ cwd: e.target.value })}
              placeholder="/absolute/path/to/repo"
              className="flex-1 min-w-0 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              onClick={onPickCwd}
              className="px-2 py-1 text-[11px] rounded border border-line text-fg-dim hover:text-fg hover:bg-bg-hi"
              title="Pick directory"
            >
              Browse…
            </button>
          </div>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <span className="w-28 shrink-0 text-fg-faint pt-1">estimateMinutes*</span>
          <input
            type="number"
            min={1}
            value={fm.estimateMinutes ?? ''}
            onChange={(e) => patch({ estimateMinutes: num(e.target.value) })}
            placeholder="e.g. 60"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="flex items-start gap-2 text-xs">
          <span className="w-28 shrink-0 text-fg-faint pt-1">parallelGroup</span>
          <input
            type="number"
            min={0}
            max={99}
            value={fm.parallelGroup ?? ''}
            onChange={(e) => patch({ parallelGroup: num(e.target.value) })}
            placeholder="0-99 (matches NN- slug prefix)"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
          />
        </label>

        {customFieldKeys.length > 0 && (
          <div className="pt-2 mt-1 border-t border-line/60">
            <button
              type="button"
              onClick={onToggleCustomFields}
              className="text-[10px] text-fg-faint hover:text-fg-dim"
            >
              {showCustomFields ? '▾' : '▸'} custom fields ({customFieldKeys.length}) - round-trip preserved
            </button>
            {showCustomFields && (
              <pre className="mt-1 text-[11px] text-fg-faint whitespace-pre-wrap font-mono leading-5">
                {customFieldKeys
                  .map((k) => (fm.extras?.[k]?.lines ?? []).join('\n'))
                  .join('\n')}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Body editor (Monaco markdown) */}
      <div>
        <div className="text-[10px] uppercase tracking-wide text-fg-faint mb-1">body</div>
        <div style={{ height: '500px' }}>
          <MarkdownEditor
            value={body}
            onChange={onBodyChange}
            path={`/scheduler/prds/${slug}.body.md`}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Bundle D — bulk modals ────────────────────────────────────────────────

function ArchiveConfirmModal({
  open, count, busy, onClose, onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Archive PRDs">
      <p className="text-xs text-fg-dim">
        Move <span className="font-mono">{count}</span> PRD{count === 1 ? '' : 's'} to{' '}
        <span className="font-mono">prds-archived/&lt;timestamp&gt;/</span>?
      </p>
      <p className="text-[10px] text-fg-faint mt-2">
        Files are renamed, never deleted. Restore manually from disk if needed.
      </p>
      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-2 py-1 text-xs border border-line rounded text-fg-dim hover:text-fg disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || count === 0}
          className="px-2 py-1 text-xs border border-accent/60 text-accent rounded hover:bg-bg-hi disabled:opacity-40"
        >
          {busy ? 'Archiving…' : `Archive ${count}`}
        </button>
      </div>
    </Modal>
  )
}

function RetagModal({
  open, count, busy, onClose, onConfirm,
}: {
  open: boolean
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: (parallelGroup: number | null, estimateMinutes: number | null) => void
}) {
  const [groupStr, setGroupStr] = useState('')
  const [estimateStr, setEstimateStr] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setGroupStr('')
      setEstimateStr('')
      setErr(null)
    }
  }, [open])

  function submit() {
    setErr(null)
    let pg: number | null = null
    let em: number | null = null
    if (groupStr.trim()) {
      const v = Number(groupStr)
      if (!Number.isInteger(v) || v < 0 || v > 999) {
        setErr('parallelGroup must be 0–999')
        return
      }
      pg = v
    }
    if (estimateStr.trim()) {
      const v = Number(estimateStr)
      if (!Number.isInteger(v) || v <= 0) {
        setErr('estimateMinutes must be a positive integer')
        return
      }
      em = v
    }
    if (pg === null && em === null) {
      setErr('set at least one field')
      return
    }
    onConfirm(pg, em)
  }

  return (
    <Modal open={open} onClose={onClose} title="Retag PRDs">
      <p className="text-xs text-fg-dim">
        Update <span className="font-mono">{count}</span> PRD{count === 1 ? '' : 's'}. Leave a field blank to keep its current value.
      </p>
      <p className="text-[10px] text-fg-faint mt-2">
        Changing parallelGroup on an <span className="font-mono">NN-kebab</span> slug renames the file.
        Every change is logged to <span className="font-mono">retag-log.jsonl</span> so it's reversible.
      </p>
      <div className="mt-3 space-y-2">
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-fg-faint">parallelGroup:</span>
          <input
            type="number"
            min={0}
            max={999}
            value={groupStr}
            onChange={(e) => setGroupStr(e.target.value)}
            placeholder="(unchanged)"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <span className="w-32 text-fg-faint">estimateMinutes:</span>
          <input
            type="number"
            min={1}
            value={estimateStr}
            onChange={(e) => setEstimateStr(e.target.value)}
            placeholder="(unchanged)"
            className="flex-1 bg-bg border border-line rounded px-2 py-1 font-mono text-xs"
          />
        </label>
      </div>
      {err && <div className="mt-2 text-[10px] text-red-300">{err}</div>}
      <div className="flex justify-end gap-2 mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="px-2 py-1 text-xs border border-line rounded text-fg-dim hover:text-fg disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || count === 0}
          className="px-2 py-1 text-xs border border-accent/60 text-accent rounded hover:bg-bg-hi disabled:opacity-40"
        >
          {busy ? 'Retagging…' : `Retag ${count}`}
        </button>
      </div>
    </Modal>
  )
}
