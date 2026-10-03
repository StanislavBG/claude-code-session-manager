/**
 * SessionActionsBar — the Sessions workspace toolbar, one button per hot key.
 *
 * "+ New Session" is fixed; then one button per Macro shown in the active
 * project (machine-local macro library, `lib/useMacros.ts`), then "New Macro"
 * and a "⋯" manage panel (per-project visibility, edit, delete).
 *
 * Pressing a Macro button is the same act as pressing "+ New Session" and
 * filling the card in — it goes through the one Epic-minting IPC handler that
 * holds MINT_AUTHORITY_NEW_EPIC_UI (see `src/main/lib/epicMint.cjs`), composes
 * its opening prompt through `composeEpicIntake` (Actor = the macro's agent,
 * Mission = its tag, Goal = its prompt), approves it out of `proposed`, and
 * sends that prompt. A shortcut around the New Session card, never a second
 * creation path.
 */
import { useState } from 'react'
import { toast } from '../../state/toast'
import { useAgentPersonas } from '../../lib/useAgentPersonas'
import { useMacros, macrosForProject } from '../../lib/useMacros'
import { useMacroLaunch } from '../../lib/useMacroLaunch'
import { normalizeCwd } from '../../lib/knownProjectAggregate'
import type { Macro } from '../../../preload/api'
import { MacroEditor } from './MacroEditor'

const BTN =
  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
const SECONDARY = `${BTN} bg-bg-hi text-fg-dim border-line hover:text-fg`

function macroTooltip(m: Macro): string {
  const first = m.prompt.split('\n').find((l) => l.trim()) ?? ''
  return `Start a new ${m.tag} session as "${m.agentName}": ${first.trim()}`
}

function ManagePanel({
  macros,
  cwd,
  onEdit,
}: {
  macros: Macro[]
  cwd: string | null
  onEdit: (m: Macro) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const here = cwd ? normalizeCwd(cwd) : null

  const toggle = async (m: Macro, enabled: boolean) => {
    if (!cwd) return
    try {
      const r = await window.api.macros.setProject({ id: m.id, cwd, enabled })
      if (!r.ok) toast.error(r.error)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }
  const remove = async (m: Macro) => {
    setConfirming(null)
    try {
      await window.api.macros.delete({ id: m.id })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div data-testid="hotkey-manage-panel" className="flex flex-col gap-1 rounded-lg border border-line bg-bg-hi p-2">
      {macros.map((m) => {
        const all = m.projects.includes('*')
        const shown = all || (here !== null && m.projects.some((p) => normalizeCwd(p) === here))
        return (
          <div key={m.id} data-testid="hotkey-manage-row" data-macro-id={m.id} className="flex items-center gap-1.5 text-[11.5px]">
            <label className="flex min-w-0 flex-1 items-center gap-1.5 text-fg-dim" title={all ? 'Shown in every project' : 'Shown in this project'}>
              <input
                type="checkbox"
                data-testid="hotkey-manage-toggle"
                checked={shown}
                disabled={all || !cwd}
                onChange={(e) => void toggle(m, e.target.checked)}
                aria-label={`Show ${m.label} in this project`}
              />
              <span className="truncate text-fg">{m.label}</span>
              {all && <span className="shrink-0 text-[10px] text-fg-faint">every project</span>}
            </label>
            {confirming === m.id ? (
              <>
                <span className="text-fg-dim">Delete?</span>
                <button type="button" data-testid="hotkey-delete-yes" onClick={() => void remove(m)} className="font-semibold text-red-500">
                  Yes
                </button>
                <button type="button" data-testid="hotkey-delete-no" onClick={() => setConfirming(null)} className="text-fg-dim hover:text-fg">
                  No
                </button>
              </>
            ) : (
              <>
                <button type="button" data-testid="hotkey-edit" onClick={() => onEdit(m)} className="text-fg-dim hover:text-fg">
                  Edit
                </button>
                <button type="button" data-testid="hotkey-delete" onClick={() => setConfirming(m.id)} className="text-fg-dim hover:text-red-500">
                  Delete
                </button>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

export interface SessionActionsBarProps {
  onNew: () => void
  onSelect: (id: string) => void
}

export function SessionActionsBar({ onNew, onSelect }: SessionActionsBarProps) {
  const personas = useAgentPersonas()
  const { launch, launching, cwd } = useMacroLaunch(onSelect, personas)
  const library = useMacros()
  const macros = macrosForProject(library, cwd)
  const [editor, setEditor] = useState<{ macro: Macro | null } | null>(null)
  const [managing, setManaging] = useState(false)

  return (
    <div className="flex flex-col gap-2" data-testid="session-actions-bar">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onNew}
          data-testid="epic-queue-new"
          className={`${BTN} bg-accent text-white border-transparent shadow-sm`}
        >
          + New Session
        </button>

        {macros.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => void launch(m)}
            disabled={launching !== null}
            title={macroTooltip(m)}
            data-testid="hotkey-macro"
            data-macro-id={m.id}
            className={SECONDARY}
          >
            {launching === m.id ? 'Starting…' : m.label}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setEditor({ macro: null })}
          disabled={!cwd}
          title={cwd ? 'Create a hot key that starts a session with a saved agent, tag and prompt' : 'Open a project tab to create a macro'}
          data-testid="hotkey-new-macro"
          className={SECONDARY}
        >
          New Macro
        </button>

        {library.length > 0 && (
          <button
            type="button"
            onClick={() => setManaging((v) => !v)}
            aria-label="Manage hot keys"
            aria-expanded={managing}
            title="Manage hot keys"
            data-testid="hotkey-manage"
            className={`${SECONDARY} px-2`}
          >
            ⋯
          </button>
        )}
      </div>

      {managing && library.length > 0 && (
        <ManagePanel
          macros={library}
          cwd={cwd}
          onEdit={(m) => {
            setEditor({ macro: m })
          }}
        />
      )}

      {editor && cwd && (
        <MacroEditor
          key={editor.macro?.id ?? 'new'}
          cwd={cwd}
          agents={personas}
          macro={editor.macro}
          latest={editor.macro ? library.find((m) => m.id === editor.macro!.id) ?? null : null}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  )
}
