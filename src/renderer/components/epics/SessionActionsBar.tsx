/**
 * SessionActionsBar — the Sessions workspace toolbar, one button per Action.
 *
 * Replaces the single "Actions" dropdown that used to hold exactly `+ New
 * Session` and `Run Build`. Every Action is now its own button, and the list is
 * **project-dynamic**: besides the two fixed entries, one button is rendered
 * per Agent Library persona scoped to the active project (`projects:` in
 * `~/.claude/agents/<name>.md`, resolved by `lib/projectActions.ts`).
 *
 * Pressing an Action button is the same act as pressing "+ New Session" and
 * filling the card in — it goes through the one Epic-minting IPC handler that
 * holds MINT_AUTHORITY_NEW_EPIC_UI (see `src/main/lib/epicMint.cjs`), composes
 * its opening prompt through `composeEpicIntake` so the session opens on the
 * full AIM framing (Actor = the persona, Mission = its tag, Goal = its
 * `action:` line), approves it out of `proposed`, and sends that prompt. It is
 * a shortcut around the New Session card, never a second creation path.
 *
 * `builder` is deliberately excluded from the dynamic list: it already has a
 * dedicated "Run Build" button whose publish-target gating and in-flight
 * dedup a generic Action can't express, and two buttons for one agent would
 * only be confusing.
 */
import { useState } from 'react'
import { usePromptSessions } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useChat } from '../../state/chat'
import { toast } from '../../state/toast'
import { composeEpicIntake } from '../../lib/epicIntake'
import { useProjectActions } from '../../lib/useProjectActions'
import type { ProjectAction } from '../../lib/projectActions'

/** The persona whose Action is expressed by the dedicated Run Build button. */
export const BUILD_PERSONA_NAME = 'builder'

const BTN =
  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

/**
 * Creates + starts the Session an Action button stands for. Shared shape with
 * `EpicQueue`'s own build action: mint -> approve -> send the opening prompt.
 */
export function useActionLaunch(onSelect: (id: string) => void) {
  const activeTabCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)
  const [launching, setLaunching] = useState<string | null>(null)

  const launch = async (action: ProjectAction) => {
    if (!activeTabCwd || launching) return
    setLaunching(action.agentName)
    try {
      const { goalText, openingPrompt, sections } = composeEpicIntake({
        title: action.label,
        goal: action.action,
        tag: action.tag,
        agentName: action.agentName,
        agentDescription: action.agentDescription ?? undefined,
      })
      const session = await usePromptSessions
        .getState()
        .createPromptSession(activeTabCwd, goalText, action.tag, `SessionActionsBar ${action.agentName}`, action.agentName, openingPrompt, sections)
      usePromptSessions.getState().approveProposed(session.id, `SessionActionsBar ${action.agentName}`)
      useChat.getState().send({
        tabId: session.id,
        sessionId: session.claudeSessionId,
        cwd: activeTabCwd,
        prompt: openingPrompt,
      })
      onSelect(session.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setLaunching(null)
    }
  }

  return { launch, launching, cwd: activeTabCwd }
}

export interface SessionActionsBarProps {
  onNew: () => void
  onSelect: (id: string) => void
  /** The dedicated Build action, wired by EpicQueue (publish-target gating +
   *  in-flight dedup live there). Omitted in contexts with no build concept. */
  build?: { disabled: boolean; inFlight: unknown; tooltip: string; handleClick: () => void | Promise<void> }
}

export function SessionActionsBar({ onNew, onSelect, build }: SessionActionsBarProps) {
  const { launch, launching, cwd } = useActionLaunch(onSelect)
  const actions = useProjectActions(cwd).filter((a) => a.agentName !== BUILD_PERSONA_NAME)

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="session-actions-bar">
      <button
        type="button"
        onClick={onNew}
        data-testid="epic-queue-new"
        className={`${BTN} bg-accent text-white border-transparent shadow-sm`}
      >
        + New Session
      </button>

      {build && (
        <button
          type="button"
          onClick={() => void build.handleClick()}
          disabled={build.disabled}
          title={build.tooltip}
          data-testid="epic-queue-build"
          className={`${BTN} bg-bg-hi text-fg-dim border-line hover:text-fg`}
        >
          {build.inFlight ? 'Open Build' : 'Run Build'}
        </button>
      )}

      {actions.map((a) => (
        <button
          key={a.agentName}
          type="button"
          onClick={() => void launch(a)}
          disabled={launching !== null}
          title={a.tooltip}
          data-testid="session-action"
          data-agent={a.agentName}
          className={`${BTN} bg-bg-hi text-fg-dim border-line hover:text-fg`}
        >
          {launching === a.agentName ? 'Starting…' : a.label}
        </button>
      ))}
    </div>
  )
}
