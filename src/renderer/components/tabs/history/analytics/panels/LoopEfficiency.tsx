import { useEffect, useState } from 'react'
import { CARD, SectionHead } from '../analytics-primitives'
import { useToast } from '../../../../../state/toast'

type LoopEfficiencyResult = Awaited<ReturnType<Window['api']['history']['loopEfficiency']>>

export const WASTED_TARGET = 0.05
const EM_DASH = '—'

const usd = (n: number) => `$${n.toFixed(2)}`

export function LoopEfficiency() {
  const [data, setData] = useState<LoopEfficiencyResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const show = useToast((s) => s.show)

  useEffect(() => {
    let alive = true
    const load = () => {
      window.api.history
        .loopEfficiency()
        .then((r) => {
          if (!alive) return
          setData(r)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!alive) return
          const msg = e instanceof Error ? e.message : String(e)
          setError(msg)
          show('error', `Loop efficiency failed to load: ${msg}`)
        })
    }
    load()
    const off = window.api.history.onUpdated(load)
    return () => {
      alive = false
      off()
    }
  }, [show])

  let body
  if (error && !data) {
    body = <div data-testid="loop-eff-error" className="text-[11px] font-mono text-fg-faint">Failed to load: {error}</div>
  } else if (!data) {
    body = <div data-testid="loop-eff-loading" className="text-[11px] font-mono text-fg-faint">Loading…</div>
  } else if (data.rows.length === 0) {
    body = <div data-testid="loop-eff-empty" className="text-[11px] font-mono text-fg-faint">No runs this week.</div>
  } else {
    const over = data.totals.wastedRunRate > WASTED_TARGET
    body = (
      <>
        <table className="w-full text-[11px] font-mono" data-testid="loop-eff-table">
          <thead>
            <tr className="text-fg-faint text-left">
              <th className="font-normal">Project</th>
              <th className="font-normal text-right">Runs</th>
              <th className="font-normal text-right">Wasted</th>
              <th className="font-normal text-right">Verified</th>
              <th className="font-normal text-right">Refuted</th>
              <th className="font-normal text-right">List-price $</th>
              <th className="font-normal text-right">$ / verified</th>
            </tr>
          </thead>
          <tbody className="text-fg-dim">
            {data.rows.map((r) => (
              <tr key={r.cwd} data-testid="loop-eff-row">
                <td>{r.project}</td>
                <td className="text-right">{r.runs}</td>
                <td className="text-right">{r.wastedRuns}</td>
                <td className="text-right">{r.verified}</td>
                <td className="text-right">{r.refuted}</td>
                <td className="text-right">{usd(r.executorUsd)}</td>
                <td className="text-right" data-testid="loop-eff-per-verified">
                  {r.usdPerVerified == null ? EM_DASH : usd(r.usdPerVerified)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div
          data-testid="loop-eff-totals"
          data-warning={over ? 'true' : 'false'}
          className={`mt-2 text-[11px] font-mono ${over ? 'text-amber-300' : 'text-fg-dim'}`}
        >
          wasted runs {(data.totals.wastedRunRate * 100).toFixed(1)}% ({data.totals.wastedRuns}/{data.totals.runs}) · target ≤ 5%
        </div>
        <div data-testid="loop-eff-usage" className="mt-1 text-[11px] font-mono text-fg-faint">
          {data.verifiedPerUsagePct != null
            ? `${data.verifiedPerUsagePct} verified PRDs per 1% of weekly usage`
            : 'weekly usage unavailable'}
        </div>
      </>
    )
  }

  return (
    <div className={`${CARD} p-4`} data-testid="loop-efficiency">
      <SectionHead kicker="06 · reliability" title="Loop efficiency" />
      {body}
    </div>
  )
}
