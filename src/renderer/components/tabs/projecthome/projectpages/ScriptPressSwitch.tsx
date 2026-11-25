/**
 * Project Home ▸ Video's 'Scripts' disclosure: the per-project 'Scripts may run Demo Video' switch
 * (main: videoScriptPress.cjs / videoScriptSwitchIpc.cjs). Collapsed by default — the owner rule is
 * no new tab, nav entry or app-level switch, so it lives in the pane Demo Video already lives in.
 * Opening it reads the switch (`videos:script-switch-get`); the checkbox writes it
 * (`videos:script-switch-set`, recorded as a human click). The last change shows who made it:
 * `by.via` 'ui' = you, 'agent' = an agent quoting you. IPC errors go to the toast.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../../../../state/toast'
import type { VideoScriptSwitchState } from '../../../../../preload/api'

export const SCRIPT_RUN_ROUTE = 'POST /admin/project-home/videos/run'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 'changed by you' / 'changed by an agent quoting you' from `by.via`; null when never set or unknown. */
export function changedByLabel(state: VideoScriptSwitchState | null): string | null {
  const via = state?.by?.via
  if (via === 'ui') return 'changed by you'
  if (via === 'agent') return 'changed by an agent quoting you'
  return null
}

export interface ScriptPressSwitchProps {
  cwd?: string | null
}

export function ScriptPressSwitch({ cwd }: ScriptPressSwitchProps) {
  const showToast = useToast((s) => s.show)
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<VideoScriptSwitchState | null>(null)
  const [busy, setBusy] = useState(false)
  // Drops a read that lands after a newer read / write, or after the cwd changed.
  const seq = useRef(0)

  useEffect(() => {
    setState(null)
  }, [cwd])

  useEffect(() => {
    if (!open || !cwd) return
    const mine = ++seq.current
    window.api.projectPages
      .scriptSwitchGet({ cwd })
      .then((s) => {
        if (mine === seq.current) setState(s)
      })
      .catch((e: unknown) => {
        if (mine === seq.current) showToast('error', `Could not read the Scripts switch: ${errMsg(e)}`)
      })
  }, [open, cwd, showToast])

  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!cwd || busy) return
      const mine = ++seq.current
      setBusy(true)
      try {
        const s = await window.api.projectPages.scriptSwitchSet({ cwd, enabled })
        if (mine === seq.current) setState(s)
      } catch (e) {
        showToast('error', `Could not change the Scripts switch: ${errMsg(e)}`)
      } finally {
        setBusy(false)
      }
    },
    [cwd, busy, showToast],
  )

  const by = changedByLabel(state)

  return (
    <div data-testid="script-press-switch" className="flex flex-none flex-col gap-1.5">
      <button
        type="button"
        data-testid="script-press-switch-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 self-start bg-transparent px-0.5 font-mono text-[10.5px] tracking-[.1em] text-fg-faint cursor-pointer hover:text-fg"
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        Scripts
      </button>
      {open && (
        <div
          data-testid="script-press-switch-body"
          className="flex flex-col gap-1 rounded-[9px] border border-rule-structural bg-bg-hi px-3 py-2"
        >
          <label className="flex items-center gap-2 text-[12.5px] text-fg cursor-pointer">
            <input
              type="checkbox"
              data-testid="script-press-switch-checkbox"
              checked={state?.enabled ?? false}
              disabled={!cwd || state === null || busy}
              onChange={(e) => void toggle(e.target.checked)}
            />
            Scripts may run Demo Video
          </label>
          <span data-testid="script-press-switch-hint" className="text-[11.5px] text-fg-dim">
            Lets this project's own scripts start Demo Video via <code className="font-mono">{SCRIPT_RUN_ROUTE}</code>.
          </span>
          {by && (
            <span data-testid="script-press-switch-by" className="font-mono text-[10.5px] text-fg-faint">
              {by}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
