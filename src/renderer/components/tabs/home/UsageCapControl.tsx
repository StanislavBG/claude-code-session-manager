import { useScheduleState } from '../../../state/scheduleState'
import { toast } from '../../../state/toast'
import { formatRelative } from '../../../lib/formatTime'
import { windowKindLabel } from '../../../lib/usageWindow'
import { ClickToEditNumber } from '../scheduler/sched-primitives'

/**
 * Home's one control (owner's explicit exception to the view-only Dashboard):
 * the automatic-work 'pause above' cap. Same saved value + IPC as the
 * Scheduler band's `kpi-threshold` — no new setting.
 */
export function UsageCapControl() {
  const snapshot = useScheduleState((s) => s.snapshot)
  if (!snapshot) return null
  if ((snapshot.config.firePolicy ?? 'when-available') !== 'when-available') return null

  const saved = snapshot.config.utilizationThreshold ?? 90
  const effective = typeof snapshot.effectiveUtilizationThreshold === 'number'
    ? Math.round(snapshot.effectiveUtilizationThreshold * 10) / 10
    : null
  const hold = snapshot.utilizationHold ?? null

  const commit = (n: number) => {
    Promise.resolve()
      .then(() => window.api.schedule.setConfig({ utilizationThreshold: n }))
      .then((res) => { if (res && res.ok === false) toast.error('Could not save the usage cap') })
      .catch((err) => { toast.error(`Could not save the usage cap: ${err instanceof Error ? err.message : String(err)}`) })
  }

  let holdDetail: string | null = null
  if (hold) {
    const win = windowKindLabel(hold.window)
    const wait = hold.resetsAt ? Date.parse(hold.resetsAt) - Date.now() : null
    holdDetail = [
      `${win ? `${win} ` : ''}at ${Math.round(hold.percent)}% ≥ ${hold.threshold}%`,
      wait != null && !Number.isNaN(wait) && wait > 0 ? `resets in ${formatRelative(wait)}` : null,
    ].filter(Boolean).join(' · ')
  }

  return (
    <div data-testid="home-usage-cap" className="mt-2 text-[12.5px] text-fg-dim">
      <span>
        Automatic work pauses above{' '}
        <ClickToEditNumber
          value={saved}
          min={0}
          max={100}
          testId="home-usage-cap-value"
          title="Same setting as the Scheduler's 'pause above': new automatic work holds when the highest usage window is at/above this percent. The cap rises toward 99% as the window's reset nears — click to edit"
          onCommit={commit}
        />
        {effective != null && effective !== saved && (
          <span data-testid="home-usage-cap-effective" title="Cap in force now — pro-rated toward 99% as the usage window's reset nears">
            {' · now '}{effective}%
          </span>
        )}
      </span>
      {hold && (
        <div data-testid="home-usage-cap-held" className="mt-1 text-amber-700">
          Held now{holdDetail ? ` — ${holdDetail}` : ''}
        </div>
      )}
    </div>
  )
}
