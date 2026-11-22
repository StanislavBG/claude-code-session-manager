import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { TaskDetail as TaskDetailRecord } from '../../../../preload/api.d'
import { useToast } from '../../../state/toast'
import { usd } from '../../../lib/analyticsFormat'
import { formatTaskDuration, formatTaskStart } from './TasksView'

/**
 * Read-only drill-down for one Task (window.api.tasks.get) — facts, the exact
 * prompt sent and the output returned, so a human can audit any call. A panel
 * beside the TasksView list (no route, no nav entry); closes on Escape or the
 * close button. Editing / re-running a Task is out of scope.
 */

export interface TaskDetailProps {
  cwd: string
  taskId: string
  onClose: () => void
}

function slotWait(t: TaskDetailRecord): string {
  if (typeof t.slotWaitMs === 'number') return formatTaskDuration(t.slotWaitMs)
  if (typeof t.slotWaitSec === 'number') return formatTaskDuration(t.slotWaitSec * 1000)
  return '—'
}

function quotaState(t: TaskDetailRecord): string {
  if (!t.quota) return '—'
  if (!t.quota.rateLimited) return 'ok'
  return t.quota.resetsAt ? `rate limited · resets ${formatTaskStart(t.quota.resetsAt)}` : 'rate limited'
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="font-mono text-fg break-all" data-testid={`task-detail-fact-${label.replace(/\s+/g, '-').toLowerCase()}`}>{children}</dd>
    </>
  )
}

function TextBlock({ label, testid, text, sha, bytes, truncated, onCopy }: {
  label: string
  testid: string
  text: string | undefined
  sha: string | undefined
  bytes: number | undefined
  truncated: boolean
  onCopy: (label: string, text: string) => void
}) {
  return (
    <section className="mt-3" data-testid={testid}>
      <div className="flex items-center gap-2 mb-1 text-[12px]">
        <h4 className="font-semibold text-fg uppercase tracking-wider">{label}</h4>
        {truncated && (
          <span
            data-testid={`${testid}-truncated`}
            title="The stored copy was capped at 1 MiB; the sha256 is of the full text."
            className="px-1.5 py-px rounded border border-honey/50 text-honey-dark text-[11px]"
          >
            truncated
          </span>
        )}
        {typeof bytes === 'number' && <span className="text-fg-faint font-mono text-[11px]">{bytes} B</span>}
        <button
          type="button"
          data-testid={`${testid}-copy`}
          disabled={text === undefined}
          onClick={() => { if (text !== undefined) onCopy(label, text) }}
          className="ml-auto px-1.5 py-px rounded border border-line text-[11px] text-fg-dim hover:bg-bg-elev disabled:opacity-50"
        >
          Copy
        </button>
      </div>
      <div className="text-[11px] font-mono text-fg-faint break-all mb-1" data-testid={`${testid}-sha`}>
        sha256 {sha ?? '—'}
      </div>
      <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg bg-bg-hi border border-line rounded p-2">
        {text ?? '(no body stored)'}
      </pre>
    </section>
  )
}

export function TaskDetail({ cwd, taskId, onClose }: TaskDetailProps) {
  const show = useToast((s) => s.show)
  const [task, setTask] = useState<TaskDetailRecord | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')

  useEffect(() => {
    let live = true
    setState('loading')
    setTask(null)
    window.api.tasks.get({ cwd, id: taskId }).then((res) => {
      if (!live) return
      if (!res.ok) { setState('error'); show('error', `Task ${taskId}: ${res.error}`); return }
      if (!res.task) { setState('missing'); return }
      setTask(res.task)
      setState('ready')
    }).catch((e: unknown) => {
      if (!live) return
      setState('error')
      show('error', `Task ${taskId}: ${e instanceof Error ? e.message : String(e)}`)
    })
    return () => { live = false }
  }, [cwd, taskId, show])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copy = useCallback(async (label: string, text: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      show('info', `${label} copied`)
    } catch (e) {
      show('error', `Copy ${label.toLowerCase()} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [show])

  const caller = task?.caller
  return (
    <aside className="h-full overflow-y-auto px-4 py-4 border-l border-line bg-bg" data-testid="task-detail">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-[13px] font-semibold text-fg font-mono truncate" title={taskId}>Task {taskId}</h3>
        {task?.source === 'direct' && (
          <span
            data-testid="task-detail-badge-direct"
            title="Imported: this call ran directly, outside Session Manager's slot cap."
            className="inline-block px-1.5 py-px rounded border border-honey/50 text-honey-dark text-[11px] whitespace-nowrap"
          >
            ran without SM
          </span>
        )}
        <button
          type="button"
          data-testid="task-detail-close"
          onClick={onClose}
          aria-label="Close Task detail"
          className="ml-auto px-2 py-0.5 rounded border border-line text-[12px] text-fg-dim hover:bg-bg-elev"
        >
          Close
        </button>
      </div>

      {state === 'loading' && <div className="text-[12px] text-fg-faint">Loading…</div>}
      {state === 'missing' && <div className="text-[12px] text-fg-faint" data-testid="task-detail-missing">This Task is no longer in the ledger.</div>}
      {state === 'error' && <div className="text-[12px] text-accent-dark">Could not load this Task.</div>}

      {task && (
        <>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <Fact label="Status">{task.status}</Fact>
            <Fact label="Exit code">{typeof task.exitCode === 'number' ? task.exitCode : '—'}</Fact>
            <Fact label="Agent">{task.agent ?? '—'}</Fact>
            <Fact label="Model">{task.model ?? '—'}</Fact>
            <Fact label="Effort">{task.effort ?? '—'}</Fact>
            <Fact label="Mission">{task.missionId ?? '—'}</Fact>
            <Fact label="Pipeline">{caller?.pipeline ?? '—'}</Fact>
            <Fact label="Run">{caller?.runId ?? '—'}</Fact>
            <Fact label="Step">{caller?.step ?? '—'}</Fact>
            <Fact label="Attempt">{typeof caller?.attempt === 'number' ? caller.attempt : '—'}</Fact>
            <Fact label="Started">{formatTaskStart(task.startedAt)}</Fact>
            <Fact label="Quota">{quotaState(task)}</Fact>
            <Fact label="Slot wait">{slotWait(task)}</Fact>
            <Fact label="Duration">{formatTaskDuration(task.durationMs)}</Fact>
            <Fact label="Cost">{typeof task.costUsd === 'number' ? usd(task.costUsd) : '—'}</Fact>
            {task.error && <Fact label="Error">{task.error}</Fact>}
          </dl>
          <TextBlock
            label="Prompt"
            testid="task-detail-prompt"
            text={task.body?.prompt}
            sha={task.promptSha256}
            bytes={task.promptBytes}
            truncated={task.body?.promptTruncated === true}
            onCopy={(l, t) => { void copy(l, t) }}
          />
          <TextBlock
            label="Output"
            testid="task-detail-output"
            text={task.body?.output}
            sha={task.outputSha256}
            bytes={task.outputBytes}
            truncated={task.body?.outputTruncated === true}
            onCopy={(l, t) => { void copy(l, t) }}
          />
        </>
      )}
    </aside>
  )
}
