/**
 * Project Home's single-page view: one button per `surface: 'project-home'`
 * Macro (Generate/Regenerate, depending on whether that macro's own artifact
 * exists), plus — once at least one artifact exists — a two-view segmented
 * switch between the generated Overview (home.html) and the Demo video.
 *
 * `output`/`demoVideo`/`loaded` come from ProjectHome's single
 * `useProjectPagesOutput` call; `macros`/`launching`/`onLaunch` come from its
 * `useMacroLaunch` wiring. Purely presentational — no store access here.
 */
import { useState } from 'react'
import { formatAgo } from '../../../../lib/formatTime'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { HtmlFrame } from './HtmlFrame'
import { DemoVideoFrame } from './DemoVideoFrame'
import type { ProjectPagesOutput, ProjectPagesDemoVideo } from '../../../../lib/projectPages/useProjectPagesOutput'
import type { Macro } from '../../../../../preload/api'

const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg-hi cursor-pointer hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

function macroButtonLabel(macro: Macro, hasHome: boolean, hasDemo: boolean): string {
  if (macro.id === 'builtin-project-home') return hasHome ? `Regenerate ${macro.label}` : `Generate ${macro.label}`
  if (macro.id === 'builtin-demo-video') return hasDemo ? `Regenerate ${macro.label}` : `Generate ${macro.label}`
  return macro.label
}

function MacroButton({
  macro,
  hasHome,
  hasDemo,
  launching,
  onLaunch,
}: {
  macro: Macro
  hasHome: boolean
  hasDemo: boolean
  launching: string | null
  onLaunch: (macro: Macro, extraInstructions?: string) => void
}) {
  const [extra, setExtra] = useState('')
  const disabled = launching !== null
  const showExtraInput = hasHome || hasDemo

  const fire = () => {
    const trimmed = extra.trim()
    onLaunch(macro, trimmed || undefined)
    setExtra('')
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      {showExtraInput && (
        <input
          type="text"
          data-testid="project-home-macro-extra"
          data-macro-id={macro.id}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          disabled={disabled}
          placeholder="Optional: extra instructions for this regeneration"
          className="rounded-lg border border-line bg-bg-hi px-2.5 py-2 text-xs text-fg placeholder:text-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
        />
      )}
      <button
        type="button"
        data-testid="project-home-macro"
        data-macro-id={macro.id}
        disabled={disabled}
        onClick={fire}
        className={BUTTON_CLASS}
      >
        <span className="inline-flex">
          <AlmanacIcon name="sparkle" size={14} />
        </span>
        {launching === macro.id ? 'Starting…' : macroButtonLabel(macro, hasHome, hasDemo)}
      </button>
    </div>
  )
}

type View = 'overview' | 'demo'

function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const options: { value: View; label: string }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'demo', label: 'Demo video' },
  ]
  return (
    <div
      data-testid="project-home-view"
      className="flex gap-0.5 p-0.5 rounded bg-bg-elev shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)] text-[11px]"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`px-2 py-1 rounded whitespace-nowrap font-semibold ${
            view === opt.value ? 'bg-bg-hi text-fg shadow-sm' : 'text-fg-faint hover:text-fg'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

export function ProjectPagesSection({
  output,
  demoVideo,
  loaded,
  macros,
  launching,
  onLaunch,
}: {
  output: ProjectPagesOutput | null
  demoVideo: ProjectPagesDemoVideo
  loaded: boolean
  macros: Macro[]
  launching: string | null
  onLaunch: (macro: Macro, extraInstructions?: string) => void
}) {
  const [view, setView] = useState<View>('overview')

  if (!loaded) return null

  const hasHome = !!output
  const hasDemo = !!demoVideo

  if (!hasHome && !hasDemo) {
    return (
      <div className="flex justify-center py-16">
        <div className="flex flex-col items-center gap-2.5">
          {macros.map((m) => (
            <MacroButton key={m.id} macro={m} hasHome={hasHome} hasDemo={hasDemo} launching={launching} onLaunch={onLaunch} />
          ))}
        </div>
      </div>
    )
  }

  const activeView: View = hasDemo && (!hasHome || view === 'demo') ? 'demo' : 'overview'
  const chipMtimeMs = activeView === 'demo' ? demoVideo!.mtimeMs : output!.mtimeMs

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2.5">
        {hasDemo ? <ViewSwitch view={activeView} onChange={setView} /> : <div />}
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[10.5px] text-fg-faint">generated {formatAgo(chipMtimeMs, Date.now())}</span>
          {macros.map((m) => (
            <MacroButton key={m.id} macro={m} hasHome={hasHome} hasDemo={hasDemo} launching={launching} onLaunch={onLaunch} />
          ))}
        </div>
      </div>
      <div
        className="overflow-hidden rounded-xl border border-line bg-bg-hi"
        style={{ height: 'calc(100vh - 200px)', minHeight: 520 }}
      >
        {activeView === 'overview' ? (
          <HtmlFrame title="Project Home" html={output!.html} />
        ) : (
          <DemoVideoFrame path={demoVideo!.path} mtimeMs={demoVideo!.mtimeMs} />
        )}
      </div>
    </div>
  )
}
