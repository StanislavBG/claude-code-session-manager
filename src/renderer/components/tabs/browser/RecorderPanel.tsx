/**
 * Recorder panel — record/pause/stop/replay transport, live step list, and
 * export footer. Ported from `docs/design/browser-tab.design.jsx`
 * `RecorderPanel` + `REC_STEPS` + `REC_EXPORTS`; mock state swapped for the
 * PRD-408 engine (`window.api.browser.recordStart/recordStop/onRecordStep`)
 * via the browser store's recorder slice.
 *
 * Replay (`window.api.browser.replay`/`onReplayStep`) and the three export
 * destinations (Playwright spec / Markdown repro / PRD fixture) are PRD 410
 * — replay drives the live view step-by-step and the exports are written
 * via the same atomic `config.writeText` path CapturePanel uses.
 */
import { useEffect, useState } from 'react'
import { AlmanacIcon, type AlmanacIconName } from '../../layout/AlmanacIcon'
import { useBrowserState } from '../../../state/browser'
import { useSessions } from '../../../state/sessions'
import { toast } from '../../../state/toast'
import { destPath } from '../../../lib/captureDest'
import { stepsToPlaywright, stepsToCanonical } from '../../../lib/browserExport'
import type { ReplayStepResult } from '../../../../preload/api'
import { PanelShell, SectionLabel } from './panel-primitives'

// Mirrors ptyWrite's PTY_WRITE_MAX_BYTES cap in src/main/ipcSchemas.cjs:36
// (main-only constant, not importable from the renderer).
const PTY_WRITE_MAX_BYTES = 64 * 1024

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

const REC_EXPORTS: { id: 'clipboard' | 'session' | 'file' | 'pw'; label: string; hint: string; primary?: boolean }[] = [
  { id: 'clipboard', label: 'Copy to clipboard', hint: 'Markdown + JSON fixture' },
  { id: 'session', label: 'Send to session', hint: 'insert into active terminal' },
  { id: 'file', label: 'Save to file…', hint: 'native Save As dialog' },
  { id: 'pw', label: 'Playwright spec', hint: 'tests/e2e/*.spec.ts', primary: true },
]

function verbColor(verb: string) {
  if (verb === 'navigate') return 'text-sage'
  if (verb === 'wait-for') return 'text-butter'
  if (verb === 'drag') return 'text-butter'
  return 'text-accent'
}

function coordHint(x?: number, y?: number): string | null {
  if (x === undefined || y === undefined) return null
  return `(${x}, ${y})`
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
  const [replaying, setReplaying] = useState(false)
  const [replayResults, setReplayResults] = useState<Record<number, ReplayStepResult>>({})
  const [exporting, setExporting] = useState(false)

  // Entering record mode starts the engine session; leaving stops it.
  useEffect(() => {
    if (!viewId) return
    startRecording(viewId)
    return () => stopRecording(viewId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId])

  useEffect(() => {
    if (!viewId) return
    return window.api.browser.onReplayStep(viewId, (step) => {
      setReplayResults((prev) => ({ ...prev, [step.n]: step }))
    })
  }, [viewId])

  const onReplay = async () => {
    if (!viewId || recorderSteps.length === 0 || replaying) return
    setReplaying(true)
    setReplayResults({})
    try {
      const result = await window.api.browser.replay({ viewId, steps: recorderSteps })
      if (!result.ok) throw new Error(result.error || 'replay failed')
      if (result.stopped) toast.error(`Replay stopped at step ${result.failedAt}`)
      else toast.info('Replay passed')
    } catch (e) {
      toast.error(`Replay failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReplaying(false)
    }
  }

  const saveExport = async (dirBase: string, ext: string, content: string) => {
    const path = destPath(dirBase, 'recorded', ext)
    const result = await window.api.config.writeText(path, content)
    if (!result.ok) throw new Error('save failed')
    toast.info(`Saved: ${path}`)
  }

  const onExport = async (id: 'clipboard' | 'session' | 'file' | 'pw') => {
    if (recorderSteps.length === 0 || exporting) return
    setExporting(true)
    try {
      if (id === 'pw') {
        const cwd = await window.api.app.cwd()
        await saveExport(`${cwd}/tests/e2e`, 'spec.ts', stepsToPlaywright(recorderSteps, { title: 'Recorded flow' }))
      } else if (id === 'clipboard') {
        const result = await window.api.clipboard.writeText(stepsToCanonical(recorderSteps))
        if (!result.ok) throw new Error(result.error || 'clipboard write failed')
        toast.info('Copied to clipboard')
      } else if (id === 'session') {
        const activeTabId = useSessions.getState().activeTabId
        if (!activeTabId) {
          toast.error('No active terminal tab')
          return
        }
        const payload = `Here is a recorded browser flow — turn it into what I ask next:\n\n${stepsToCanonical(recorderSteps)}`
        if (payload.length > PTY_WRITE_MAX_BYTES) {
          const result = await window.api.clipboard.writeText(payload)
          if (!result.ok) throw new Error(result.error || 'clipboard write failed')
          toast.info('Flow too large for the terminal — copied to clipboard, paste it in instead')
        } else {
          window.api.pty.write({ tabId: activeTabId, data: payload })
          toast.info('Sent to session')
        }
      } else if (id === 'file') {
        const result = await window.api.browser.saveRecording({
          defaultName: 'recorded-flow.md',
          text: stepsToCanonical(recorderSteps),
        })
        if (result.ok) toast.info(`Saved: ${result.path}`)
        else if ('error' in result) toast.error(result.error || 'save failed')
      }
    } catch (e) {
      toast.error(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setExporting(false)
    }
  }

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
                disabled={recorderSteps.length === 0 || exporting}
                onClick={() => onExport(e.id)}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
                  e.primary ? 'cursor-pointer border-accent bg-accent' : 'cursor-pointer border-line bg-bg-hi'
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
          <IconBtn
            name="play"
            title={replaying ? 'Replaying…' : 'Replay'}
            size={13}
            onClick={onReplay}
            disabled={!viewId || recorderSteps.length === 0 || replaying}
          />
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
                  {s.verb === 'drag'
                    ? s.target && s.endTarget
                      ? `${s.target} → ${s.endTarget}`
                      : `${coordHint(s.x, s.y) ?? '(?, ?)'} → ${coordHint(s.endX, s.endY) ?? '(?, ?)'}`
                    : s.target}
                </span>
                {s.verb === 'click' && coordHint(s.x, s.y) && (
                  <span className="flex-shrink-0 font-mono text-[10.5px] text-fg-faint">{coordHint(s.x, s.y)}</span>
                )}
                {s.variable && (
                  <span className="rounded border border-accent-muted bg-bg px-1.5 py-px font-mono text-[10.5px] font-bold text-accent">
                    {`{{${s.variable}}}`}
                  </span>
                )}
                {replayResults[s.n] && (
                  <span
                    title={replayResults[s.n].detail}
                    className={`ml-auto flex-shrink-0 rounded px-1.5 py-px font-mono text-[10.5px] font-bold ${
                      replayResults[s.n].status === 'pass'
                        ? 'bg-sage/20 text-sage'
                        : 'bg-[#c0503a]/20 text-[#c0503a]'
                    }`}
                  >
                    {replayResults[s.n].status === 'pass' ? '✓ pass' : '✗ fail'}
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
                    {s.verb === 'drag' && (
                      <>
                        <div>
                          <span className="text-fg-faint">from </span>
                          {s.target || '(no selector)'} {coordHint(s.x, s.y)}
                        </div>
                        <div>
                          <span className="text-fg-faint">to </span>
                          {s.endTarget || '(no selector)'} {coordHint(s.endX, s.endY)}
                        </div>
                      </>
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
