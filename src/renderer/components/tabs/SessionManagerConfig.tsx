import { useEffect, useState } from 'react'
import { GlobalControlsSection } from './GlobalControlsSection'
import { Toggle } from '../ui/Toggle'
import { readAppPrefs, writeAppPrefs } from '../../lib/appPrefs'
import { toast } from '../../state/toast'
import { useSessionSlots } from '../../lib/useSessionSlots'
import type { NavKey } from '../LeftNav'

/**
 * SessionManagerConfig — the home for GLOBAL (machine-level) configuration,
 * as opposed to per-project state the Scheduler browses. Per the domain
 * model (CLAUDE.md): the scheduler is scoped to TAB → EPIC → PRD; caps,
 * limits, and runtime policy belong to Session-Manager itself:
 *
 *   - the machine-wide claude -p session pool (lib/sessionSlots.cjs)
 *   - where the global runtime state lives on disk
 *
 * Fire policy / utilization threshold / concurrency cap are deliberately
 * NOT duplicated here — Scheduler.tsx renders this directly above
 * SchedulePanel, whose PolicyBar already owns those same live-editable
 * controls (window.api.schedule.setConfig); a second copy here just drifted
 * out of sync with whichever one the user last touched.
 */

interface SessionManagerConfigProps {
  navigate?: (k: NavKey) => void
}

export function SessionManagerConfig({ navigate }: SessionManagerConfigProps) {
  const slots = useSessionSlots()
  const [openToHomeOnLaunch, setOpenToHomeOnLaunch] = useState(false)
  const [prefsSaving, setPrefsSaving] = useState(false)

  useEffect(() => {
    let alive = true
    readAppPrefs().then((p) => { if (alive) setOpenToHomeOnLaunch(p.openToHomeOnLaunch === true) })
    return () => { alive = false }
  }, [])

  const toggleOpenToHomeOnLaunch = async (value: boolean) => {
    setOpenToHomeOnLaunch(value)
    setPrefsSaving(true)
    try {
      await writeAppPrefs({ openToHomeOnLaunch: value })
    } catch {
      setOpenToHomeOnLaunch(!value)
      toast.error('Failed to save "Open to Home on launch" — try again.')
    } finally {
      setPrefsSaving(false)
    }
  }

  return (
    <div className="max-w-[760px] space-y-6">
      {/* ── Global Controls ──────────────────────────────────────── */}
      <GlobalControlsSection navigate={navigate} />

      {/* ── Session pool ─────────────────────────────────────────── */}
      <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
        <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">Session pool</h2>
        <p className="mt-0 mb-3 text-[13px] text-fg-dim leading-relaxed">
          One machine-wide pool of concurrent Claude sessions. Scheduler jobs and Epic chat
          runs each request a slot before launching; work waits when the pool is full.
          Adjustable from 0 (pauses new launches) to 10 on the Home tab, default 5 — or
          pin it with{' '}
          <code className="font-mono text-[12px]">SM_SESSION_SLOTS</code> (clamped 0–10).
        </p>
        <div className="flex items-center gap-2">
          {Array.from({ length: slots?.total ?? 5 }, (_, i) => (
            <span
              key={i}
              className={`w-3.5 h-3.5 rounded-full border ${
                i < (slots?.inUse ?? 0) ? 'bg-accent border-accent' : 'bg-bg border-line'
              }`}
            />
          ))}
          <span className="ml-2 font-mono text-[12.5px] text-fg-faint">
            {slots ? `${slots.inUse} / ${slots.total} in use` : 'loading…'}
          </span>
        </div>
        {slots && slots.holders.length > 0 && (
          <ul className="mt-2 mb-0 pl-0 list-none space-y-0.5">
            {slots.holders.map((h, i) => (
              <li key={i} className="font-mono text-[12px] text-fg-dim">
                {h.owner} <span className="text-fg-faint">since {new Date(h.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Behavior ──────────────────────────────────────────────── */}
      <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
        <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">Behavior</h2>
        <p className="mt-0 mb-3 text-[13px] text-fg-dim leading-relaxed">
          Cross-project app behavior, independent of any single project's config.
        </p>
        <Toggle
          checked={openToHomeOnLaunch}
          onChange={toggleOpenToHomeOnLaunch}
          disabled={prefsSaving}
          label="Open to Home on launch"
        />
      </section>

      {/* ── Where global state lives ─────────────────────────────── */}
      <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
        <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">On disk</h2>
        <p className="mt-0 mb-2 text-[13px] text-fg-dim leading-relaxed">
          Global runtime state is deliberately small — everything project-scoped lives inside
          that project's <code className="font-mono text-[12px]">session-manager-operations/</code> folder.
        </p>
        <ul className="m-0 pl-0 list-none space-y-1 font-mono text-[12px] text-fg-dim">
          <li>~/.claude/session-manager/scheduler-machine.json <span className="text-fg-faint">— policy + pause state</span></li>
          <li>&lt;project&gt;/session-manager-operations/scheduler/state/ <span className="text-fg-faint">— per-project queue + history</span></li>
          <li>&lt;project&gt;/session-manager-operations/scheduler/epics/&lt;epic&gt;/prds/ <span className="text-fg-faint">— PRD sources, per Epic</span></li>
        </ul>
      </section>
    </div>
  )
}
