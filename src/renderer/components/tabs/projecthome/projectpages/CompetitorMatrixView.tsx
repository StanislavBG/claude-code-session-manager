/**
 * Project Home ▸ Tools ▸ Competitor matrix. Reads the saved matrix with one
 * `window.api.projectPages.matrix({ cwd })` call per cwd, again on Refresh, and
 * again when the macro's job goes from queued/running to done — never on a
 * timer. Four competitor slots (Auto / Named / Off, prefilled from the saved
 * matrix via `competitorSlots`) feed the 'Competitors:' line the primary button
 * launches the macro with. The matrix renders one table per feature group
 * (self first, then each competitor); a feature row toggles its detail panel.
 * Text-only rendering — research data comes from public web pages.
 *
 * Every feature this project lacks or only partly has gets a 'Start session'
 * button, and the header 'Start all missing (N)' / 'Add all as proposed (N)'.
 * All three press launchSession — the same path as New Session (architect
 * actor, feature mission). A feature whose Session already exists in this cwd
 * (matched on the Sessions-list title) shows 'Open session' instead, so a
 * second press never mints a duplicate.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { toast } from '../../../../state/toast'
import { usePromptSessions } from '../../../../state/promptSessions'
import { launchSession } from '../../../../lib/launchSession'
import { splitTitleAndGoal } from '../../../../lib/epicDerive'
import {
  competitorSlots,
  competitorsLine,
  featureSessionGoal,
  featureSessionTitle,
  groupedFeatures,
  isMissingFeature,
  missingFeatures,
  statusLabel,
  type CompetitorSlot,
  type CompetitorSlotMode,
} from '../../../../lib/competitorMatrix'
import type {
  CompetitiveMatrix,
  CompetitorMatrixResult,
  Macro,
  MacroJobStatus,
  MatrixFeature,
  MatrixSupportStatus,
} from '../../../../../preload/api'

type LaunchFn = (macro: Macro, extraInstructions?: string, inputValues?: Record<string, string>) => void

type MatrixLoad =
  | { cwd: string; status: 'loading'; matrix: CompetitiveMatrix | null }
  | { cwd: string; status: 'ready'; matrix: CompetitiveMatrix | null; warning: string | null }
  | { cwd: string; status: 'error'; error: string }

const PRIMARY_CLASS =
  'inline-flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-lg bg-accent px-[15px] text-[13px] font-semibold text-bg-hi cursor-pointer hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'
const SMALL_BTN_CLASS =
  'inline-flex h-[26px] flex-none items-center gap-1.5 rounded-md border border-rule-structural bg-bg-hi px-2.5 text-[11.5px] font-semibold text-fg-dim cursor-pointer hover:border-fg-faint hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed'

const STATUS_TONE: Record<MatrixSupportStatus, string> = {
  yes: 'text-sage-dark',
  partial: 'text-honey',
  no: 'text-accent',
  unknown: 'text-fg-faint',
}

const EMPTY_TEXT =
  'No matrix yet. Run research to compare this project with up to four competitors: each slot can name a product, let the research pick one (Auto), or stay Off. The result is a grouped feature matrix with sources, user sentiment and a priority per feature.'

const START_SOURCE = 'CompetitorMatrix start-session'
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)) || 'Unknown error'

/** The Sessions list's title for an Epic: the first line of its goalText. */
const epicListTitle = (goalText: string) => splitTitleAndGoal(goalText ?? '').title.split('\n')[0]

interface StartControls {
  /** featureSessionTitle -> existing Epic id in this cwd. */
  started: Map<string, string>
  starting: boolean
  canStart: boolean
  onStart: (f: MatrixFeature) => void
  onOpen: (epicId: string) => void
}

function FeatureStartButton({ feature, ctl }: { feature: MatrixFeature; ctl: StartControls }) {
  if (!isMissingFeature(feature)) return null
  const existing = ctl.started.get(featureSessionTitle(feature))
  return (
    <button
      type="button"
      data-testid="competitor-matrix-start"
      data-feature-id={feature.id}
      data-epic-id={existing}
      disabled={ctl.starting || (!existing && !ctl.canStart)}
      onClick={(e) => {
        e.stopPropagation()
        if (existing) ctl.onOpen(existing)
        else ctl.onStart(feature)
      }}
      className={SMALL_BTN_CLASS}
    >
      {existing ? 'Open session' : 'Start session'}
    </button>
  )
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
const isBusy = (s?: MacroJobStatus) => s?.state === 'queued' || s?.state === 'running'
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '')

/** Loads `cwd`'s matrix once, on `reload`, and never on a timer; a load a newer one replaced is dropped. */
function useMatrixLoad(cwd: string | null | undefined) {
  const [load, setLoad] = useState<MatrixLoad | null>(null)
  const requestedCwd = useRef<string | null>(null)
  const latest = useRef(0)

  const start = useCallback((forCwd: string) => {
    requestedCwd.current = forCwd
    const id = ++latest.current
    setLoad((prev) => ({
      cwd: forCwd,
      status: 'loading',
      matrix: prev?.cwd === forCwd && prev.status !== 'error' ? prev.matrix : null,
    }))
    let pending: Promise<CompetitorMatrixResult>
    try {
      pending = window.api.projectPages.matrix({ cwd: forCwd })
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.then(
      (res) => {
        if (id !== latest.current) return
        setLoad(
          res.ok
            ? { cwd: forCwd, status: 'ready', matrix: res.matrix, warning: res.error }
            : { cwd: forCwd, status: 'error', error: res.error },
        )
      },
      (err: unknown) => {
        if (id !== latest.current) return
        const message = (err instanceof Error ? err.message : String(err)) || 'Unknown error'
        setLoad({ cwd: forCwd, status: 'error', error: message })
        toast.error(`Could not load the competitor matrix: ${message}`)
      },
    )
  }, [])

  useEffect(() => {
    if (cwd && requestedCwd.current !== cwd) start(cwd)
  }, [cwd, start])

  const reload = useCallback(() => {
    if (cwd) start(cwd)
  }, [cwd, start])

  return { load: load?.cwd === cwd ? load : null, reload }
}

function sourcesFor(feature: MatrixFeature, matrix: CompetitiveMatrix) {
  const ids: string[] = []
  const add = (list: string[] | undefined) => {
    for (const id of list ?? []) if (!ids.includes(id)) ids.push(id)
  }
  add(feature.sentiment?.sourceIds)
  for (const cell of Object.values(feature.support ?? {})) add(cell?.sourceIds)
  return ids.map((id) => matrix.sources.find((s) => s.id === id)).filter((s) => s !== undefined)
}

function FeatureDetail({ feature, matrix, colSpan }: { feature: MatrixFeature; matrix: CompetitiveMatrix; colSpan: number }) {
  const sources = sourcesFor(feature, matrix)
  return (
    <tr>
      <td colSpan={colSpan} className="border-t border-rule-inner bg-bg-elev px-3.5 py-3">
        <div data-testid="competitor-matrix-detail" className="flex flex-col gap-2 text-[12.5px] leading-[1.5] text-fg-dim">
          <p className="m-0 text-fg">{feature.description || 'No description recorded.'}</p>
          <p className="m-0">
            <span className="font-semibold text-fg">Sentiment: </span>
            <span className="font-mono text-[11px]">{feature.sentiment?.signal ?? 'none'}</span>
            {feature.sentiment?.summary ? ` — ${feature.sentiment.summary}` : ''}
          </p>
          <p className="m-0">
            <span className="font-semibold text-fg">Priority: </span>
            <span className="font-mono text-[11px]">{feature.recommendation?.priority ?? 'none'}</span>
            {feature.recommendation?.rationale ? ` — ${feature.recommendation.rationale}` : ''}
          </p>
          <div className="flex flex-col gap-1">
            <span className="font-semibold text-fg">Sources</span>
            {sources.length === 0 ? (
              <span className="text-fg-faint">None recorded.</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {sources.map((s) => (
                  <li key={s.id} data-testid="competitor-matrix-source" className="flex flex-wrap gap-x-2">
                    <span className="text-fg">{s.title}</span>
                    <span>{s.publisher}</span>
                    {s.publishedAt && <span className="font-mono text-[11px]">{day(s.publishedAt)}</span>}
                    <span className="break-all font-mono text-[11px] text-fg-faint">{s.url}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

function MatrixTables({ matrix, ctl }: { matrix: CompetitiveMatrix; ctl: StartControls }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const products = [
    { id: 'self', name: matrix.product.name },
    ...matrix.competitors.map((c) => ({ id: c.id, name: c.name })),
  ]
  return (
    <>
      {groupedFeatures(matrix).map(({ group, features }) => (
        <section key={group.id} data-testid="competitor-matrix-group" data-group-id={group.id} className="flex flex-none flex-col gap-1.5">
          <div className="flex flex-col gap-0.5">
            <h3 className="m-0 font-serif text-[16px] font-semibold text-fg">{group.title}</h3>
            {group.description && <span className="text-[12px] text-fg-faint">{group.description}</span>}
          </div>
          <div className="overflow-auto rounded-[10px] border border-rule-structural">
            <table className="w-full border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="bg-bg-elev">
                  <th className="px-3 py-2 font-mono text-[10.5px] font-semibold tracking-[.06em] text-fg-faint">Feature</th>
                  {products.map((p) => (
                    <th key={p.id} className="whitespace-nowrap px-3 py-2 text-[12px] font-semibold text-fg">
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {features.length === 0 && (
                  <tr>
                    <td colSpan={products.length + 1} className="px-3 py-2 text-fg-faint">
                      No features in this group yet.
                    </td>
                  </tr>
                )}
                {features.map((f) => {
                  const open = openId === f.id
                  return (
                    <Fragment key={f.id}>
                      <tr
                        data-testid="competitor-matrix-feature"
                        data-feature-id={f.id}
                        aria-expanded={open}
                        onClick={() => setOpenId(open ? null : f.id)}
                        className={`cursor-pointer border-t border-rule-inner hover:bg-bg-hi ${open ? 'bg-bg-hi' : ''}`}
                      >
                        <td className="px-3 py-2 font-semibold text-fg">
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            <AlmanacIcon name={open ? 'collapse' : 'expand'} size={11} />
                            {f.title}
                            <FeatureStartButton feature={f} ctl={ctl} />
                          </span>
                        </td>
                        {products.map((p) => {
                          const c = f.support?.[p.id]
                          const st = c?.status ?? 'unknown'
                          const lbl = statusLabel(st)
                          return (
                            <td
                              key={p.id}
                              data-testid="competitor-matrix-cell"
                              data-status={st}
                              title={c?.note || undefined}
                              className={`whitespace-nowrap px-3 py-2 ${STATUS_TONE[st] ?? STATUS_TONE.unknown}`}
                            >
                              {`${lbl.symbol} ${lbl.label}`}
                            </td>
                          )
                        })}
                      </tr>
                      {open && <FeatureDetail feature={f} matrix={matrix} colSpan={products.length + 1} />}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  )
}

export const CompetitorMatrixView = memo(function CompetitorMatrixView({
  cwd,
  macro,
  onLaunch,
  launching,
  jobStatus,
  onOpenSession,
}: {
  cwd?: string | null
  macro: Macro
  onLaunch: LaunchFn
  launching: string | null
  /** This macro's latest job (ProjectHome's useMacroJobStatus). */
  jobStatus?: MacroJobStatus
  /** Opens an Epic by id — after a single Start session, and for Open session. */
  onOpenSession?: (epicId: string) => void
}) {
  const { load, reload } = useMatrixLoad(cwd)
  const busy = isBusy(jobStatus)

  // Reload once when the job leaves queued/running for done.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy && jobStatus?.state === 'done') reload()
    wasBusy.current = busy
  }, [busy, jobStatus?.state, reload])

  const matrix = load && load.status !== 'error' ? load.matrix : null
  // Slot edits are keyed to the matrix they started from; a reloaded matrix re-prefills.
  const slotKey = `${cwd ?? ''}|${matrix?.updatedAt ?? ''}`
  const [slotEdit, setSlotEdit] = useState<{ key: string; slots: CompetitorSlot[] } | null>(null)
  const slots = slotEdit?.key === slotKey ? slotEdit.slots : competitorSlots(matrix)
  const setSlot = (i: number, patch: Partial<CompetitorSlot>) =>
    setSlotEdit({ key: slotKey, slots: slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  const line = competitorsLine(slots)
  const loading = load ? load.status === 'loading' : !!cwd
  const disabled = line === null || launching !== null || busy

  // Start-session state. The selector returns the stored object; matching lives in useMemo.
  const sessions = usePromptSessions((s) => s.sessions)
  const started = useMemo(() => {
    const map = new Map<string, string>()
    for (const epic of Object.values(sessions)) {
      if (epic.cwd !== cwd) continue
      const title = epicListTitle(epic.goalText)
      if (!map.has(title)) map.set(title, epic.id)
    }
    return map
  }, [sessions, cwd])
  const missing = useMemo(() => (matrix ? missingFeatures(matrix) : []), [matrix])
  const notStarted = missing.filter((f) => !started.has(featureSessionTitle(f)))
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)

  const launchFeature = (f: MatrixFeature, m: CompetitiveMatrix, approve: boolean) =>
    launchSession({
      cwd: cwd as string,
      agentName: 'architect',
      tag: 'feature',
      title: featureSessionTitle(f),
      goal: featureSessionGoal(f, m),
      source: START_SOURCE,
      ...(approve ? {} : { approve: false }),
    })

  const begin = () => {
    if (startingRef.current || !cwd || !matrix) return false
    startingRef.current = true
    setStarting(true)
    return true
  }
  const end = () => {
    startingRef.current = false
    setStarting(false)
  }

  const startOne = async (f: MatrixFeature) => {
    if (!matrix || !begin()) return
    try {
      const { epicId } = await launchFeature(f, matrix, true)
      onOpenSession?.(epicId)
    } catch (err) {
      toast.error(`Could not start a session for "${f.title}": ${errText(err)}`)
    } finally {
      end()
    }
  }

  const startAll = async (approve: boolean) => {
    if (!matrix || startingRef.current || !cwd) return
    const todo = notStarted
    const skipped = missing.length - todo.length
    if (todo.length === 0) return
    if (approve && !window.confirm(`Start ${todo.length} sessions now? They share this machine's session slots with scheduled jobs.`)) return
    if (!begin()) return
    let added = 0
    let failed = 0
    try {
      for (const f of todo) {
        try {
          await launchFeature(f, matrix, approve)
          added++
        } catch (err) {
          failed++
          toast.error(`Could not start a session for "${f.title}": ${errText(err)}`)
        }
      }
    } finally {
      end()
    }
    const head = approve
      ? `Started ${plural(added, 'session')}`
      : `Added ${added} proposed ${added === 1 ? 'session' : 'sessions'} — approve them in Sessions`
    toast.success(`${head}${skipped > 0 ? `, skipped ${skipped} already started` : ''}${failed > 0 ? `, ${failed} failed` : ''}`)
  }

  const ctl: StartControls = {
    started,
    starting,
    canStart: !!cwd,
    onStart: (f) => void startOne(f),
    onOpen: (id) => onOpenSession?.(id),
  }
  const bulkDisabled = starting || !cwd || notStarted.length === 0

  return (
    <div data-testid="competitor-matrix" data-has-session-handler={onOpenSession ? 'true' : undefined} className="flex flex-col gap-3.5">
      <div className="flex flex-none flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-[3px]">
          <h2 data-testid="project-home-tool-title" className="m-0 font-serif text-[22px] font-semibold leading-[1.15] text-fg">
            {macro.label}
          </h2>
          {matrix ? (
            <>
              <span data-testid="competitor-matrix-heading" className="text-[13.5px] font-semibold text-fg-dim">
                {`${matrix.product.name} vs ${plural(matrix.competitors.length, 'competitor')}`}
              </span>
              <span data-testid="competitor-matrix-meta" className="font-mono text-[11px] text-fg-faint">
                {`Updated ${day(matrix.updatedAt)} · ${plural(matrix.runs.length, 'run')}`}
              </span>
            </>
          ) : (
            <span data-testid="project-home-tool-sub" className="font-mono text-[11px] text-fg-faint">
              {`built-in macro · ${macro.agentName}`}
            </span>
          )}
        </div>
        {missing.length > 0 && (
          <>
            <button
              type="button"
              data-testid="competitor-matrix-start-all"
              disabled={bulkDisabled}
              onClick={() => void startAll(true)}
              className={SMALL_BTN_CLASS}
            >
              {`Start all missing (${notStarted.length})`}
            </button>
            <button
              type="button"
              data-testid="competitor-matrix-propose-all"
              disabled={bulkDisabled}
              onClick={() => void startAll(false)}
              className={SMALL_BTN_CLASS}
            >
              {`Add all as proposed (${notStarted.length})`}
            </button>
          </>
        )}
        <button type="button" data-testid="competitor-matrix-refresh" disabled={!cwd || loading} onClick={reload} className={SMALL_BTN_CLASS}>
          <AlmanacIcon name="reload" size={12} stroke={2} />
          Refresh
        </button>
      </div>

      <div data-testid="competitor-slots" className="flex max-w-[560px] flex-none flex-col gap-1.5">
        <span className="font-mono text-[10.5px] tracking-[.1em] text-fg-faint">COMPETITORS</span>
        {slots.map((s, i) => (
          <div key={i} data-testid="competitor-slot" className="flex items-center gap-2">
            <select
              data-testid="competitor-slot-mode"
              aria-label={`Competitor ${i + 1} mode`}
              value={s.mode}
              onChange={(e) => setSlot(i, { mode: e.target.value as CompetitorSlotMode })}
              className="h-[30px] w-[96px] flex-none rounded-lg border border-rule-structural bg-bg-hi px-2 text-[12.5px] text-fg cursor-pointer"
            >
              <option value="auto">Auto</option>
              <option value="named">Named</option>
              <option value="off">Off</option>
            </select>
            <input
              data-testid="competitor-slot-name"
              aria-label={`Competitor ${i + 1} name`}
              value={s.name}
              disabled={s.mode !== 'named'}
              placeholder={s.mode === 'auto' ? 'Picked by research' : s.mode === 'off' ? 'Off' : 'Product name'}
              onChange={(e) => setSlot(i, { name: e.target.value })}
              className="h-[30px] min-w-0 flex-1 rounded-lg border border-rule-structural bg-bg-hi px-2.5 text-[12.5px] text-fg disabled:opacity-50"
            />
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2.5 pt-1">
          <button
            type="button"
            data-testid="competitor-matrix-run"
            data-macro-id={macro.id}
            disabled={disabled}
            onClick={() => {
              if (line !== null) onLaunch(macro, line)
            }}
            className={PRIMARY_CLASS}
          >
            <AlmanacIcon name="sparkle" size={14} />
            {launching === macro.id ? 'Starting…' : matrix ? 'Update matrix' : 'Run research'}
          </button>
          {busy && (
            <span data-testid="competitor-matrix-status" className="inline-flex items-center gap-2 text-[12.5px] text-fg-dim">
              <span className="h-[7px] w-[7px] flex-none rounded-full bg-honey animate-pulse" />
              Researching…
            </span>
          )}
        </div>
      </div>

      {load?.status === 'error' ? (
        <div data-testid="competitor-matrix-error" className="flex-none rounded-[10px] bg-bg-elev px-3.5 py-2.5 text-[12.5px] text-accent">
          {`Could not load the competitor matrix: ${load.error}`}
        </div>
      ) : load?.status === 'ready' && load.warning ? (
        <div data-testid="competitor-matrix-warning" className="flex-none rounded-[10px] bg-bg-elev px-3.5 py-2.5 text-[12.5px] text-accent">
          {`The saved matrix could not be read: ${load.warning}`}
        </div>
      ) : null}

      {matrix ? (
        <MatrixTables key={slotKey} matrix={matrix} ctl={ctl} />
      ) : loading ? (
        <p data-testid="competitor-matrix-loading" className="m-0 text-xs text-fg-faint">
          Loading matrix…
        </p>
      ) : load?.status === 'ready' ? (
        <p data-testid="competitor-matrix-empty" className="m-0 max-w-[72ch] text-[13.5px] leading-[1.55] text-fg-dim">
          {EMPTY_TEXT}
        </p>
      ) : null}
    </div>
  )
})
