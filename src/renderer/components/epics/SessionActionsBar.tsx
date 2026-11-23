/**
 * SessionActionsBar — the Sessions workspace toolbar, one button per hot key.
 *
 * "+ New Session" is fixed; then one button per Macro shown in the active
 * project (machine-local macro library, `lib/useMacros.ts`), then "New Macro"
 * and a "⋯" manage panel (per-project visibility, edit, delete). A
 * `surface: 'project-video'` macro is one project's own Video tool (Project
 * Home ▸ Video): it is never shown here — not in the strip, not in the manage
 * panel — so no other project can switch it on.
 *
 * Pressing a Macro button is the same act as pressing "+ New Session" and
 * filling the card in — it goes through the one Epic-minting IPC handler that
 * holds MINT_AUTHORITY_NEW_EPIC_UI (see `src/main/lib/epic/epicMint.cjs`), composes
 * its opening prompt through `composeEpicIntake` (Actor = the macro's agent,
 * Mission = its tag, Goal = its prompt), approves it out of `proposed`, and
 * sends that prompt. A shortcut around the New Session card, never a second
 * creation path.
 */
import { useState } from 'react'
import { toast, useToast } from '../../state/toast'
import { usePromptSessions } from '../../state/promptSessions'
import { useAgentPersonas } from '../../lib/useAgentPersonas'
import { useMacros, macrosForProject } from '../../lib/useMacros'
import { useMacroLaunch } from '../../lib/useMacroLaunch'
import { normalizeCwd } from '../../lib/knownProjectAggregate'
import type { Macro } from '../../../preload/api'
import { MacroEditor } from './MacroEditor'
import { MacroInputsForm } from './MacroInputsForm'

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
  // A '*' macro is shown in every project, so "remove from this project" is
  // refused by macroLibrary — its Delete is the editor's "Delete everywhere"
  // (deleteMacro resolves { ok: true } or throws; the catch toasts).
  const remove = async (m: Macro, all: boolean) => {
    setConfirming(null)
    try {
      if (all) {
        await window.api.macros.delete({ id: m.id })
        return
      }
      if (!cwd) return
      const r = await window.api.macros.removeFromProject({ id: m.id, cwd })
      if (!r.ok) toast.error(r.error)
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
              {m.surface === 'project-home' && (
                <span data-testid="hotkey-manage-surface" className="shrink-0 text-[10px] text-fg-faint">Project Home</span>
              )}
            </label>
            {confirming === m.id ? (
              <>
                <span className="text-fg-dim">{all ? 'Delete from every project?' : 'Remove from this project?'}</span>
                <button type="button" data-testid="hotkey-delete-yes" onClick={() => void remove(m, all)} className="font-semibold text-red-500">
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
                {/* removeFromProject refuses built-ins and rows not listed here. */}
                {!m.builtin && shown && (
                  <button type="button" data-testid="hotkey-delete" onClick={() => setConfirming(m.id)} className="text-fg-dim hover:text-red-500">
                    Delete
                  </button>
                )}
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
  /** The selected Epic — target of "Update agent" (re-pins its persona snapshot). */
  epicId?: string | null
}

export function SessionActionsBar({ onNew, onSelect, epicId = null }: SessionActionsBarProps) {
  const personas = useAgentPersonas()
  const { launch, launching, cwd } = useMacroLaunch(onSelect, personas)
  const { macros: all, loaded } = useMacros()
  // Project Video tools live only in their project's Project Home ▸ Video.
  const library = all.filter((m) => m.surface !== 'project-video')
  const macros = macrosForProject(library, cwd)
  const [editor, setEditor] = useState<{ macro: Macro | null } | null>(null)
  const [managing, setManaging] = useState(false)
  const [pending, setPending] = useState<Macro | null>(null)
  const epicCwd = usePromptSessions((s) => (epicId ? s.sessions[epicId]?.cwd ?? null : null))
  const [refreshing, setRefreshing] = useState(false)
  const epicCompleted = usePromptSessions((s) => (epicId ? s.sessions[epicId]?.status === 'completed' : false))
  // Purge confirm: the id this confirm was opened for (so switching Epics resets it) + the typed text.
  const [purgeFor, setPurgeFor] = useState<string | null>(null)
  const [purgeTyped, setPurgeTyped] = useState('')
  const [purging, setPurging] = useState(false)
  const purgeOpen = purgeFor !== null && purgeFor === epicId

  // The one human action that moves an existing Epic onto the current persona
  // version (lib/epic/epicAgentRefresh.cjs re-snapshots + audits main-side).
  const refreshAgent = async () => {
    if (!epicId || !epicCwd) return
    const show = useToast.getState().show
    setRefreshing(true)
    try {
      const r = await window.api.promptSessions.refreshAgentSnapshot({ cwd: epicCwd, epicId })
      if (!r.ok) {
        show('error', r.message)
        return
      }
      usePromptSessions.setState((st) => ({
        sessions: { ...st.sessions, [epicId]: r.session as unknown as (typeof st.sessions)[string] },
      }))
      show('info', r.changed ? 'Agent updated to the current persona version.' : 'Agent is already on the current persona version.')
    } catch (err) {
      show('error', err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }

  // The one human action that deletes a completed Epic's data (lib/epic/epicPurge.cjs
  // via epic:purge). Gated on typing the Epic id; never reachable from a script.
  const purge = async () => {
    if (!epicId || !epicCwd || purgeTyped !== epicId) return
    const show = useToast.getState().show
    setPurging(true)
    try {
      const r = await window.api.promptSessions.purge({ cwd: epicCwd, epicId })
      if (!r.ok) {
        show('error', r.error)
        return
      }
      // Main already rewrote active-index.json (row gone, tombstone kept) — drop it in memory only.
      usePromptSessions.setState((st) => {
        const sessions = { ...st.sessions }
        const events = { ...st.events }
        delete sessions[epicId]
        delete events[epicId]
        return { sessions, events }
      })
      setPurgeFor(null)
      setPurgeTyped('')
      show('info', `Session ${epicId} purged.`)
    } catch (err) {
      show('error', err instanceof Error ? err.message : String(err))
    } finally {
      setPurging(false)
    }
  }

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

        {!loaded && (
          <span data-testid="hotkey-loading" className={`${SECONDARY} opacity-60 cursor-default`}>
            Loading hot keys…
          </span>
        )}

        {macros.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => (m.inputs && m.inputs.length > 0 ? setPending(m) : void launch(m))}
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

        {epicId && (
          <button
            type="button"
            onClick={() => void refreshAgent()}
            disabled={!epicCwd || refreshing}
            title="Move this session onto its agent's current persona version"
            data-testid="epic-refresh-agent"
            className={SECONDARY}
          >
            {refreshing ? 'Updating…' : 'Update agent'}
          </button>
        )}

        {epicId && epicCompleted && (
          <button
            type="button"
            onClick={() => {
              setPurgeFor(epicId)
              setPurgeTyped('')
            }}
            disabled={!epicCwd || purging || purgeOpen}
            title="Permanently delete this completed session's transcripts, logs, PRDs and history"
            data-testid="epic-purge"
            className={`${SECONDARY} hover:text-red-500`}
          >
            Purge
          </button>
        )}

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

      {epicId && epicCompleted && purgeOpen && (
        <div data-testid="epic-purge-confirm-panel" className="flex flex-col gap-1.5 rounded-lg border border-red-500/40 bg-bg-hi p-2 text-[11.5px]">
          <span className="text-fg-dim">
            This permanently deletes the session&apos;s transcripts, run logs, PRDs, events and history. Type{' '}
            <code className="font-mono text-fg">{epicId}</code> to confirm.
          </span>
          <input
            type="text"
            data-testid="epic-purge-input"
            value={purgeTyped}
            onChange={(e) => setPurgeTyped(e.target.value)}
            aria-label="Type the session id to confirm purge"
            autoComplete="off"
            spellCheck={false}
            className="rounded-md border border-line bg-bg px-2 py-1 font-mono text-[11.5px] text-fg"
          />
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="epic-purge-confirm"
              onClick={() => void purge()}
              disabled={purgeTyped !== epicId || purging}
              className={`${BTN} bg-red-600 text-white border-transparent`}
            >
              {purging ? 'Purging…' : 'Purge forever'}
            </button>
            <button
              type="button"
              data-testid="epic-purge-cancel"
              onClick={() => {
                setPurgeFor(null)
                setPurgeTyped('')
              }}
              disabled={purging}
              className={SECONDARY}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pending && (
        <MacroInputsForm
          key={pending.id}
          macro={pending}
          onCancel={() => setPending(null)}
          onSubmit={(values) => {
            const m = pending
            setPending(null)
            void launch(m, undefined, values)
          }}
        />
      )}

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
