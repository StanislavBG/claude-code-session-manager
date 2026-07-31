import { useEffect, useState } from 'react'
import { useScheduleState } from '../../state/scheduleState'

/**
 * SessionManagerConfig — the home for GLOBAL (machine-level) configuration,
 * as opposed to per-project state the Scheduler browses. Per the domain
 * model (CLAUDE.md): the scheduler is scoped to TAB → EPIC → PRD; caps,
 * limits, and runtime policy belong to Session-Manager itself:
 *
 *   - the machine-wide claude -p session pool (lib/sessionSlots.cjs)
 *   - scheduler fire policy / utilization threshold (scheduler-machine.json)
 *   - where the global runtime state lives on disk
 */

type SlotSnapshot = { total: number; inUse: number; holders: { owner: string; at: string }[] }

export function SessionManagerConfig() {
  const snap = useScheduleState((s) => s.snapshot)
  const [slots, setSlots] = useState<SlotSnapshot | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    const poll = () => {
      window.api.schedule.sessionSlots()
        .then((s) => { if (alive) setSlots(s) })
        .catch(() => { /* diagnostic surface */ })
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const config = snap?.config

  const setPolicy = async (partial: Record<string, unknown>) => {
    setSaving(true)
    try { await window.api.schedule.setConfig(partial) } finally { setSaving(false) }
  }

  return (
    <div className="max-w-[760px] space-y-6">
      {/* ── Session pool ─────────────────────────────────────────── */}
      <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
        <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">Session pool</h2>
        <p className="mt-0 mb-3 text-[13px] text-fg-dim leading-relaxed">
          One machine-wide pool of concurrent Claude sessions. Scheduler jobs and Epic chat
          runs each request a slot before launching; work waits when the pool is full. Sized
          to this machine's memory budget — override with{' '}
          <code className="font-mono text-[12px]">SM_SESSION_SLOTS</code> (clamped 1–3).
        </p>
        <div className="flex items-center gap-2">
          {Array.from({ length: slots?.total ?? 3 }, (_, i) => (
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

      {/* ── Scheduler machine policy ─────────────────────────────── */}
      <section className="border border-line rounded-xl bg-bg-hi px-5 py-4">
        <h2 className="m-0 mb-1 font-serif text-[18px] font-semibold text-fg">Scheduler policy</h2>
        <p className="mt-0 mb-3 text-[13px] text-fg-dim leading-relaxed">
          Global runtime policy for headless PRD execution — applies across every project.
          Per-project queues and PRDs live with each project; only policy is global.
        </p>
        {config ? (
          <div className="space-y-3 text-[13px]">
            <label className="flex items-center gap-3">
              <span className="w-44 text-fg-dim">Fire policy</span>
              <select
                value={config.firePolicy}
                disabled={saving}
                onChange={(e) => setPolicy({ firePolicy: e.target.value })}
                className="bg-bg border border-line rounded px-2 py-1 text-fg"
              >
                <option value="when-available">when-available (poll usage)</option>
                <option value="on-reset">on-reset (after 5h reset)</option>
                <option value="manual">manual (Run now only)</option>
              </select>
            </label>
            <label className="flex items-center gap-3">
              <span className="w-44 text-fg-dim">Utilization threshold</span>
              <input
                type="number"
                min={10}
                max={100}
                value={config.utilizationThreshold}
                disabled={saving}
                onChange={(e) => setPolicy({ utilizationThreshold: Number(e.target.value) })}
                className="w-20 bg-bg border border-line rounded px-2 py-1 text-fg font-mono"
              />
              <span className="text-fg-faint">% of the 5-hour window</span>
            </label>
            <label className="flex items-center gap-3">
              <span className="w-44 text-fg-dim">Concurrency cap</span>
              <span className="font-mono text-fg">{config.concurrencyCap}</span>
              <span className="text-fg-faint">jobs (bounded by the session pool above)</span>
            </label>
          </div>
        ) : (
          <div className="text-[13px] text-fg-faint">loading scheduler config…</div>
        )}
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
