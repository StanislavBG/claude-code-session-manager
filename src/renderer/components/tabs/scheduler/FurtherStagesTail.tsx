import type { Stage } from '../../../lib/schedulerStages'
import { InfoDot } from './sched-primitives'

/** Strip + tail must leave 5 × STAGE_COL_W inside a 1350px viewport (see StageColumn). */
export const FURTHER_STAGES_W = 148

/** FURTHER STAGES: one mini progress row per stage beyond the visible window. Click = local scroll. */
export function FurtherStagesTail({ stages, onSeek }: { stages: Stage[]; onSeek: (i: number) => void }) {
  if (stages.length === 0) return null
  const from = stages[0].n
  const to = stages[stages.length - 1].n
  return (
    <div data-testid="further-stages" style={{ width: FURTHER_STAGES_W }} className="shrink-0 border-l border-rule-structural flex flex-col">
      <div className="h-[30px] shrink-0 flex items-center px-2 border-b border-rule-inner text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">
        Stage {from}–{to}
      </div>
      <div className="h-[22px] shrink-0 flex items-center gap-1 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-fg-faint">
        Further stages
        <InfoDot title="Stages beyond the visible window. Click one to scroll the stage columns to it." />
      </div>
      {stages.map((s) => {
        const pct = s.rows.length === 0 ? 0 : (s.doneCount / s.rows.length) * 100
        return (
          <button
            key={s.n}
            type="button"
            data-testid="further-stage-row"
            data-stage={s.n}
            title={`${s.summary} — scroll to stage ${s.n}`}
            onClick={() => onSeek(s.n - 1)}
            className="h-[26px] px-2 flex items-center gap-2 border-t border-rule-inner bg-transparent hover:bg-bg-hi cursor-pointer text-left"
          >
            <span className="font-mono text-[10.5px] text-fg-dim w-[50px] whitespace-nowrap shrink-0">stage {s.n}</span>
            <span
              role="progressbar"
              aria-valuenow={s.doneCount}
              aria-valuemin={0}
              aria-valuemax={s.rows.length}
              className="flex-1 h-[4px] rounded-sm bg-rule-inner overflow-hidden"
            >
              <span className="block h-full bg-sage" style={{ width: `${pct}%` }} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
