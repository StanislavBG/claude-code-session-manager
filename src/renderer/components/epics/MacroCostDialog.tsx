import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../ui/Modal'
import { useMacroCostPrompt } from '../../state/macroCostPrompt'
import { useModelCatalog } from '../../lib/useModelCatalog'
import { EFFORTS } from '../../lib/agentRuntimeOptions'
import { defaultLowerEffort, lowerEffortOptions } from '../../lib/macroCost'

/** Static fallback (catalog === null or empty) — the Agent Library's list minus its `inherit` chip. */
const STATIC_EFFORTS: readonly string[] = EFFORTS.filter((e) => e !== 'inherit')

const FIELD =
  'rounded-md border border-line bg-bg px-2 py-1 text-[12px] text-fg outline-none focus:border-accent'
const BTN =
  'inline-flex items-center rounded-md border border-line bg-bg px-2.5 py-1 text-[11.5px] font-semibold text-fg-dim hover:text-fg'
const BTN_ACCENT =
  'inline-flex items-center rounded-md border border-transparent bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white'

/**
 * The single host for every macro press's high-effort warning. Mounted once at the
 * app root; renders the pending useMacroCostPrompt request and answers it with the
 * human's choice — cancel, run at the agent's effort, or run at a lower effort.
 */
export function MacroCostDialog() {
  const request = useMacroCostPrompt((s) => s.request)
  const answer = useMacroCostPrompt((s) => s.answer)
  const setHostMounted = useMacroCostPrompt((s) => s.setHostMounted)
  const { catalog } = useModelCatalog(request?.cwd ?? null)

  useEffect(() => {
    setHostMounted(true)
    return () => setHostMounted(false)
  }, [setHostMounted])

  const levels = useMemo<readonly string[]>(
    () => (catalog && catalog.effortLevels.length ? catalog.effortLevels : STATIC_EFFORTS),
    [catalog],
  )
  const options = useMemo(
    () => (request ? lowerEffortOptions(request.effort, levels) : []),
    [request, levels],
  )
  const [selected, setSelected] = useState<string>('')
  useEffect(() => {
    setSelected(defaultLowerEffort(options) ?? '')
    // Re-seed only when a new request opens, not on every catalog refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])
  // A catalog that arrives after open may drop the seeded value; keep it valid.
  useEffect(() => {
    if (selected && !options.includes(selected)) setSelected(defaultLowerEffort(options) ?? '')
  }, [options, selected])

  if (!request) return null

  const lower = selected && options.includes(selected) ? selected : null

  return (
    <Modal open onClose={() => answer({ proceed: false })} title={`Run at ${request.effort} effort?`}>
      <div data-testid="macro-cost-dialog" className="flex flex-col gap-3 text-[12px] text-fg">
        <p className="text-fg">{request.message}</p>
        {options.length > 0 && (
          <label className="flex items-center gap-2 text-[11.5px] text-fg-dim">
            <span>Or run this session at</span>
            <select
              data-testid="macro-cost-effort-select"
              className={FIELD}
              value={lower ?? ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="flex items-center justify-end gap-1.5">
          <button type="button" data-testid="macro-cost-cancel" className={BTN} onClick={() => answer({ proceed: false })}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="macro-cost-run-as-is"
            className={BTN}
            onClick={() => answer({ proceed: true, effort: null })}
          >
            {`Run at ${request.effort}`}
          </button>
          {options.length > 0 && lower && (
            <button
              type="button"
              data-testid="macro-cost-run-lower"
              className={BTN_ACCENT}
              onClick={() => answer({ proceed: true, effort: lower })}
            >
              {`Run at ${lower}`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  )
}
