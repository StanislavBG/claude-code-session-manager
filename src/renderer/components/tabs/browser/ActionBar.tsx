/**
 * Bottom action bar — the "dev browser, not Chrome" tell. Ported from
 * `docs/design/browser-tab.design.jsx` `ActionBar` + `VERBS`.
 */
import { AlmanacIcon, type AlmanacIconName } from '../../layout/AlmanacIcon'
import { useBrowserState } from '../../../state/browser'

const VERBS: { id: 'capture' | 'record' | 'observe' | 'shot'; label: string; icon: AlmanacIconName }[] = [
  { id: 'capture', label: 'Capture DOM', icon: 'target' },
  { id: 'record', label: 'Record', icon: 'record' },
  { id: 'observe', label: 'Observe', icon: 'eye' },
  { id: 'shot', label: 'Screenshot', icon: 'camera' },
]

export function ActionBar() {
  const mode = useBrowserState((s) => s.mode)
  const onVerb = useBrowserState((s) => s.onVerb)

  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-t border-line bg-bg-elev px-4 py-2.5">
      <span className="mr-1.5 font-serif text-[12.5px] italic text-fg-faint">
        Hand this page to the agent →
      </span>
      {VERBS.map((v) => {
        const on = mode === v.id
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onVerb(v.id)}
            className={`inline-flex items-center gap-2 rounded-lg border px-[15px] py-2 font-sans text-[13px] font-semibold ${
              on ? 'border-accent bg-accent text-white' : 'border-line bg-bg-hi text-fg-dim'
            }`}
          >
            <span className={`inline-flex ${v.id === 'record' && !on ? 'text-red-500' : ''}`}>
              <AlmanacIcon name={v.icon} size={15} />
            </span>
            {v.label}
          </button>
        )
      })}
      <div className="ml-auto inline-flex items-center gap-2 font-mono text-[11.5px] text-fg-faint">
        <span className="inline-flex text-sage">
          <AlmanacIcon name="shield" size={13} />
        </span>
        sandboxed · no filesystem · no passwords
      </div>
    </div>
  )
}
