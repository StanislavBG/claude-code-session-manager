/**
 * Project Home's Tools tab (Project Home v2 DESIGN_SPEC §6), in the same
 * 252px list | content layout as Pages and Videos. List column: `Add a tool`
 * (the existing MacroEditor with Surface preset to Project Home), `TOOLS` +
 * count, one row per tool — `builtin-review-md-network` first, then every
 * other `surface: 'project-home'` macro except the two library builtins — and
 * a footnote. Content column, for the selected tool (first row by default):
 * Review MD network gets its Scope select, Mode segmented control and
 * `Run review`; any other macro gets a title bar plus its MacroInputsForm when
 * it declares inputs, else a primary `Run`.
 *
 * Every launch goes through `onLaunch` — ProjectHome's `useMacroLaunch`, the
 * path the Sessions hot keys use, which opens the Epic. Scope default and Mode
 * options/default are read from the live macro, never hardcoded.
 */
import { useState, type ReactNode } from 'react'
import { AlmanacIcon } from '../../../layout/AlmanacIcon'
import { MacroEditor } from '../../../epics/MacroEditor'
import { MacroInputsForm } from '../../../epics/MacroInputsForm'
import { useAgentPersonas } from '../../../../lib/useAgentPersonas'
import type { Macro } from '../../../../../preload/api'

export type LaunchFn = (macro: Macro, extraInstructions?: string, inputValues?: Record<string, string>) => void

const REVIEW_MD_NETWORK_ID = 'builtin-review-md-network'
/** Pages / Videos launch these from their own tabs. */
const LIBRARY_MACRO_IDS: readonly string[] = ['builtin-project-home', 'builtin-demo-video']
const NO_SCOPES: readonly string[] = []

const REVIEW_DESCRIPTION =
  'Maps CLAUDE.md and every doc it leads to, so agents start from one short entry map and find each fact in exactly one place — with nothing stale.'

const PRIMARY_CLASS =
  'inline-flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-lg bg-accent px-[15px] text-[13px] font-semibold text-bg-hi cursor-pointer hover:bg-accent-dark disabled:opacity-40 disabled:cursor-not-allowed'

/** Review MD network first, then the other project-home macros in the given order. */
function toolMacros(macros: readonly Macro[]): Macro[] {
  const tools = macros.filter((m) => (m.surface ?? 'sessions') === 'project-home' && !LIBRARY_MACRO_IDS.includes(m.id))
  return [...tools.filter((m) => m.id === REVIEW_MD_NETWORK_ID), ...tools.filter((m) => m.id !== REVIEW_MD_NETWORK_ID)]
}

function ToolRow({ macro, selected, onSelect }: { macro: Macro; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-testid="project-home-tool"
      data-macro-id={macro.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[9px] border px-3 py-2.5 text-left cursor-pointer transition-colors ${
        selected ? 'border-accent bg-bg-hi' : 'border-rule-structural hover:border-fg-faint'
      }`}
    >
      <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] bg-fg text-honey">
        <AlmanacIcon name={macro.id === REVIEW_MD_NETWORK_ID ? 'link' : 'tool'} size={15} stroke={1.8} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={`truncate text-[13.5px] font-semibold ${selected ? 'text-fg' : 'text-fg-dim'}`}>{macro.label}</span>
        <span className="truncate font-mono text-[10.5px] text-fg-faint">{macro.agentName}</span>
      </span>
    </button>
  )
}

/** Serif title + mono sub on the left; `children` (controls) bottom-aligned on the right. */
function TitleBar({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="flex flex-none flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-[3px]">
        <h2 data-testid="project-home-tool-title" className="m-0 font-serif text-[22px] font-semibold leading-[1.15] text-fg">
          {title}
        </h2>
        <span data-testid="project-home-tool-sub" className="font-mono text-[11px] text-fg-faint">
          {sub}
        </span>
      </div>
      {children && <div className="flex min-w-0 max-w-full flex-[0_1_auto] flex-wrap items-end gap-2.5">{children}</div>}
    </div>
  )
}

function GenericTool({ macro, launching, onLaunch }: { macro: Macro; launching: string | null; onLaunch: LaunchFn }) {
  // The form stays on screen, so Cancel resets it to the input defaults (remount).
  const [formKey, setFormKey] = useState(0)
  const hasInputs = (macro.inputs?.length ?? 0) > 0
  return (
    <>
      <TitleBar title={macro.label} sub={`${macro.agentName} · ${macro.tag}`}>
        {!hasInputs && (
          <button
            type="button"
            data-testid="project-home-run-tool"
            data-macro-id={macro.id}
            disabled={launching !== null}
            onClick={() => onLaunch(macro)}
            className={PRIMARY_CLASS}
          >
            <AlmanacIcon name="sparkle" size={14} />
            {launching === macro.id ? 'Starting…' : 'Run'}
          </button>
        )}
      </TitleBar>
      {hasInputs && (
        <div className="max-w-[420px] flex-none">
          <MacroInputsForm
            key={formKey}
            macro={macro}
            onCancel={() => setFormKey((k) => k + 1)}
            onSubmit={(values) => onLaunch(macro, undefined, values)}
          />
        </div>
      )}
    </>
  )
}

function ReviewTool({
  macro,
  scopes,
  launching,
  onLaunch,
}: {
  macro: Macro
  scopes: readonly string[]
  launching: string | null
  onLaunch: LaunchFn
}) {
  const [scopePick, setScopePick] = useState<string | null>(null)
  const [modePick, setModePick] = useState<string | null>(null)
  const scopeInput = macro.inputs?.find((i) => i.name === 'scope')
  const modeInput = macro.inputs?.find((i) => i.name === 'mode')
  const scopeOptions = Array.from(new Set([scopeInput?.default ?? '', ...scopes].filter((s) => s !== '')))
  const modeOptions = modeInput?.options ?? []
  const modeDefault =
    modeInput?.default !== undefined && modeOptions.includes(modeInput.default) ? modeInput.default : (modeOptions[0] ?? '')
  // A pick that left the options (scopes refreshed, macro reseeded) falls back to the default.
  const scope = scopePick !== null && scopeOptions.includes(scopePick) ? scopePick : (scopeOptions[0] ?? '')
  const mode = modePick !== null && modeOptions.includes(modePick) ? modePick : modeDefault
  const scopeLabel = scopeInput?.label ?? 'Scope'
  const modeLabel = modeInput?.label ?? 'Mode'

  return (
    <>
      <TitleBar title={macro.label} sub={`built-in macro · ${macro.agentName}`}>
        <div className="flex min-w-0 max-w-full flex-col gap-[5px]">
          <span className="text-[11.5px] font-semibold text-fg-dim">{scopeLabel}</span>
          <select
            data-testid="project-home-review-scope"
            aria-label={scopeLabel}
            value={scope}
            onChange={(e) => setScopePick(e.target.value)}
            className="h-[34px] max-w-full rounded-lg border border-rule-structural bg-bg-hi px-2.5 text-[12.5px] text-fg cursor-pointer"
          >
            {scopeOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        {modeOptions.length > 0 && (
          <div className="flex flex-col gap-[5px]">
            <span className="text-[11.5px] font-semibold text-fg-dim">{modeLabel}</span>
            <div role="group" aria-label={modeLabel} className="flex gap-0.5 rounded-[9px] bg-rule-inner p-[3px]">
              {modeOptions.map((o) => (
                <button
                  key={o}
                  type="button"
                  data-testid="project-home-review-mode"
                  data-mode={o}
                  aria-pressed={o === mode}
                  onClick={() => setModePick(o)}
                  className={`h-7 whitespace-nowrap rounded-[7px] px-3 text-[12.5px] cursor-pointer ${
                    o === mode ? 'bg-bg-hi font-semibold text-fg shadow-sm' : 'font-medium text-fg-faint hover:text-fg'
                  }`}
                >
                  {o}
                </button>
              ))}
            </div>
          </div>
        )}
        <button
          type="button"
          data-testid="project-home-run-review"
          disabled={launching !== null}
          onClick={() => onLaunch(macro, undefined, { scope, mode })}
          className={PRIMARY_CLASS}
        >
          <AlmanacIcon name="sparkle" size={14} />
          {launching === macro.id ? 'Starting…' : 'Run review'}
        </button>
      </TitleBar>
      <p data-testid="project-home-review-description" className="m-0 max-w-[72ch] flex-none text-[13.5px] leading-[1.55] text-fg-dim">
        {REVIEW_DESCRIPTION}
      </p>
      {/* Slot for the info strip, LINK MAP and FINDINGS cards (PRD ph2-md-link-map); nothing renders here yet. */}
    </>
  )
}

/** Mounted only while open, so personas are read on demand — the Sessions hot-key editor's agent source. */
function AddTool({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const agents = useAgentPersonas()
  return (
    <>
      <TitleBar title="Add a tool" sub="new macro" />
      <div data-testid="project-home-add-tool-editor" className="max-w-[460px] flex-none">
        <MacroEditor cwd={cwd} agents={agents} defaultSurface="project-home" onClose={onClose} />
      </div>
    </>
  )
}

export function ToolsPane({
  cwd,
  macros,
  launching,
  onLaunch,
  scopes = NO_SCOPES,
}: {
  cwd?: string | null
  /** This project's `surface: 'project-home'` macros (ProjectHome's `macrosForProject`). */
  macros: readonly Macro[]
  launching: string | null
  onLaunch: LaunchFn
  /** Review MD network Scope options offered after the scope input's default. */
  scopes?: readonly string[]
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const editing = adding && !!cwd
  const tools = toolMacros(macros)
  // First row by default; a pick survives list refreshes while its macro is still listed.
  const selected = editing ? null : (tools.find((m) => m.id === selectedId) ?? tools[0] ?? null)

  let content: ReactNode
  if (editing) content = <AddTool cwd={cwd} onClose={() => setAdding(false)} />
  else if (!selected)
    content = (
      <p data-testid="project-home-tools-empty" className="m-0 text-xs text-fg-faint">
        No tools yet.
      </p>
    )
  else if (selected.id === REVIEW_MD_NETWORK_ID)
    content = <ReviewTool key={selected.id} macro={selected} scopes={scopes} launching={launching} onLaunch={onLaunch} />
  else content = <GenericTool key={selected.id} macro={selected} launching={launching} onLaunch={onLaunch} />

  return (
    <div
      data-testid="project-home-tools"
      className="grid min-h-0 flex-1 gap-[20px]"
      style={{ gridTemplateColumns: '252px minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)' }}
    >
      <div className="flex min-h-0 flex-col gap-3">
        <button
          type="button"
          data-testid="project-home-add-tool"
          disabled={!cwd}
          onClick={() => setAdding(true)}
          className="flex h-[38px] w-full flex-none items-center justify-center gap-2 rounded-lg border border-rule-structural bg-bg-hi text-[13px] font-semibold text-fg cursor-pointer hover:border-fg-faint disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <AlmanacIcon name="plus" size={14} stroke={2} />
          Add a tool
        </button>
        <div
          data-testid="project-home-tools-header"
          className="flex flex-none items-baseline justify-between px-0.5 pt-0.5 font-mono text-[10.5px] text-fg-faint"
        >
          <span className="tracking-[.1em]">TOOLS</span>
          <span data-testid="project-home-tools-count">{tools.length}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-px">
          <ul aria-label="Tools" className="m-0 flex list-none flex-col gap-1.5 p-0">
            {tools.map((m) => (
              <li key={m.id}>
                <ToolRow
                  macro={m}
                  selected={m.id === selected?.id}
                  onSelect={() => {
                    setSelectedId(m.id)
                    setAdding(false)
                  }}
                />
              </li>
            ))}
          </ul>
          <p data-testid="project-home-tools-footnote" className="m-0 px-1 pt-2 text-[11.5px] leading-[1.45] text-fg-faint">
            Any macro saved with Surface: Project Home shows up in this list.
          </p>
        </div>
      </div>
      <div
        data-testid="project-home-tool-content"
        data-macro-id={selected?.id}
        className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto pr-0.5"
      >
        {content}
      </div>
    </div>
  )
}
