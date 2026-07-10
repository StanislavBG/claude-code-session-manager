/**
 * Recorder panel — record/pause/stop/replay transport, live step list, and
 * export footer. Ported from `docs/design/browser-tab.design.jsx`
 * `RecorderPanel` + `REC_STEPS` + `REC_EXPORTS`; mock state swapped for the
 * PRD-408 engine (`window.api.browser.recordStart/recordStop/onRecordStep`)
 * via the browser store's recorder slice.
 *
 * Replay + the three export actions (Playwright/Markdown/PRD fixture) are
 * PRD 410 — the buttons render here but are disabled/no-op until then.
 */
import { useEffect, useState } from 'react'
import { AlmanacIcon, type AlmanacIconName } from '../../layout/AlmanacIcon'
import { useBrowserState } from '../../../state/browser'
import { PanelShell, SectionLabel } from './panel-primitives'

function IconBtn({
  name,
  title,
  onClick,
  active,
  disabled,
  size = 16,
}: {
  name: AlmanacIconName
  title: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  size?: number
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`grid h-8 w-8 place-items-center rounded-lg border ${
        active ? 'border-accent bg-accent-muted/40 text-accent' : 'border-transparent text-fg-dim'
      } ${disabled ? 'cursor-default text-fg-faint' : 'cursor-pointer'}`}
    >
      <AlmanacIcon name={name} size={size} />
    </button>
  )
}

const REC_EXPORTS: { id: string; label: string; hint: string; primary?: boolean }[] = [
  { id: 'pw', label: 'Playwright spec', hint: 'tests/e2e/*.spec.ts', primary: true },
  { id: 'md', label: 'Markdown steps', hint: 'human repro' },
  { id: 'prd', label: 'PRD fixture', hint: 'feed a claude -p job' },
]

function verbColor(verb: string) {
  if (verb === 'navigate') return 'text-sage'
  if (verb === 'wait-for') return 'text-butter'
  return 'text-accent'
}

export function RecorderPanel() {
  const setMode = useBrowserState((s) => s.setMode)
  const activeTabId = useBrowserState((s) => s.activeTabId)
  const tabs = useBrowserState((s) => s.tabs)
  const recording = useBrowserState((s) => s.recording)
  const recorderElapsedSec = useBrowserState((s) => s.recorderElapsedSec)
  const recorderSteps = useBrowserState((s) => s.recorderSteps)
  const startRecording = useBrowserState((s) => s.startRecording)
  const stopRecording = useBrowserState((s) => s.stopRecording)
  const toggleRecordingPause = useBrowserState((s) => s.toggleRecordingPause)
  const toggleStepVariable = useBrowserState((s) => s.toggleStepVariable)

  const viewId = tabs.find((t) => t.id === activeTabId)?.viewId ?? null
  const [openStep, setOpenStep] = useState<number | null>(null)

  // Entering record mode starts the engine session; leaving stops it.
  useEffect(() => {
    if (!viewId) return
    startRecording(viewId)
    return () => stopRecording(viewId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId])

  const mm = String(Math.floor(recorderElapsedSec / 60)).padStart(2, '0')
  const ss = String(recorderElapsedSec % 60).padStart(2, '0')

  return (
    <PanelShell
      title="Recorder"
      icon="record"
      onClose={() => setMode('browse')}
      foot={
        <div>
          <SectionLabel>Export as</SectionLabel>
          <div className="grid gap-1.5">
            {REC_EXPORTS.map((e) => (
              <button
                key={e.id}
                type="button"
                disabled
                title="Export lands in PRD 410"
                className={`flex cursor-not-allowed items-center gap-2.5 rounded-lg border px-3 py-2 text-left opacity-90 ${
                  e.primary ? 'border-accent bg-accent' : 'border-line bg-bg-hi'
                }`}
              >
                <span className={`inline-flex ${e.primary ? 'text-white' : 'text-accent'}`}>
                  <AlmanacIcon name="send" size={14} />
                </span>
                <span className="flex-1">
                  <div className={`text-[13px] font-semibold ${e.primary ? 'text-white' : 'text-fg'}`}>
                    {e.label}
                  </div>
                  <div className={`font-mono text-[11px] ${e.primary ? 'text-white/75' : 'text-fg-faint'}`}>
                    {e.hint}
                  </div>
                </span>
              </button>
            ))}
          </div>
        </div>
      }
    >
      {/* transport */}
      <div className="mb-3.5 flex items-center gap-2.5 rounded-[10px] border border-line bg-bg-hi px-3 py-2.5">
        {recording ? (
          <span className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-[#c0503a]" />
        ) : (
          <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-rule" />
        )}
        <span className="font-mono text-[13px] font-semibold text-fg">
          {recording ? 'recording' : 'paused'} · {mm}:{ss}
        </span>
        <div className="ml-auto flex gap-1">
          <IconBtn
            name={recording ? 'pause' : 'record'}
            title={recording ? 'Pause' : 'Record'}
            onClick={toggleRecordingPause}
          />
          <IconBtn name="stop" title="Stop" size={14} onClick={() => viewId && stopRecording(viewId)} />
          <IconBtn name="play" title="Replay (PRD 410)" size={13} disabled />
        </div>
      </div>

      <SectionLabel>Steps</SectionLabel>
      <div className="grid gap-1">
        {recorderSteps.length === 0 && (
          <div className="text-[12.5px] leading-relaxed text-fg-faint">
            No steps captured yet — interact with the page to record one.
          </div>
        )}
        {recorderSteps.map((s) => {
          const on = openStep === s.n
          return (
            <div key={s.n}>
              <button
                type="button"
                onClick={() => setOpenStep(on ? null : s.n)}
                className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left ${
                  on ? 'border-accent bg-accent-muted/30' : 'border-line bg-bg-hi'
                }`}
              >
                <span className="w-[18px] flex-shrink-0 text-center font-mono text-[11.5px] text-fg-faint">
                  {s.n}
                </span>
                <span className={`w-[62px] flex-shrink-0 font-mono text-[11.5px] font-bold ${verbColor(s.verb)}`}>
                  {s.verb}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-fg">
                  {s.target}
                </span>
                {s.variable && (
                  <span className="ml-auto flex-shrink-0 rounded border border-accent-muted bg-bg px-1.5 py-px font-mono text-[10.5px] font-bold text-accent">
                    {`{{${s.variable}}}`}
                  </span>
                )}
              </button>
              {on && (
                <div className="my-1 ml-1.5 rounded-r-lg border-l-2 border-accent bg-bg-hi px-3 py-2.5">
                  <div className="font-mono text-[11.5px] leading-loose text-fg-dim">
                    <div>
                      <span className="text-fg-faint">selector </span>
                      {s.target}
                    </div>
                    {s.verb === 'type' && (
                      <div>
                        <span className="text-fg-faint">value </span>
                        {'●●●●●●'}
                        {s.variable ? ` → {{${s.variable}}}` : ''}
                      </div>
                    )}
                    {s.kind === 'assert' && (
                      <div>
                        <span className="text-fg-faint">assert </span>
                        {s.target}
                      </div>
                    )}
                  </div>
                  {s.verb === 'type' && (
                    <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-fg">
                      <input
                        type="checkbox"
                        checked={!!s.variable}
                        onChange={() => toggleStepVariable(s.n)}
                        className="h-[15px] w-[15px] rounded accent-accent"
                      />
                      parameterize as {`{{${s.variable || s.variableSuggestion || 'value'}}}`}
                    </label>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 font-serif text-[11.5px] italic text-fg-faint">
        <AlmanacIcon name="shield" size={13} /> Won&apos;t emit self-e2e jobs against scheduled plans.
      </div>
    </PanelShell>
  )
}
