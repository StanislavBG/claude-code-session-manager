/**
 * EpicApprovalBar — the human gate in front of a 'proposed' Epic.
 *
 * This is what replaced the feedback-folder intake. An agent that wants work
 * done files an Epic in status 'proposed' instead of writing a markdown file
 * into session-manager-operations/feedback/ for a separate skill to parse,
 * triage and re-queue later. Nothing runs and nothing is spent until someone
 * presses Approve here, at which point the Epic's own goalText becomes the
 * opening prompt of its session — the same start path a hand-created Epic
 * takes (lib/epicIntake), so there is one way an Epic begins, not two.
 *
 * Discard archives the proposal (markCompleted) rather than deleting it, so a
 * rejected proposal stays auditable instead of vanishing.
 */
import { useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useChat } from '../../state/chat'
import { toast } from '../../state/toast'
import { EpicKindTag } from './epic-primitives'

export function EpicApprovalBar({ epic }: { epic: PromptSession }) {
  const [busy, setBusy] = useState(false)

  const onApprove = () => {
    if (busy) return
    setBusy(true)
    try {
      const approved = usePromptSessions.getState().approveProposed(epic.id, 'EpicApprovalBar')
      if (!approved) {
        toast.error('This Epic is no longer awaiting approval.')
        return
      }
      useChat.getState().send({
        tabId: approved.id,
        sessionId: approved.claudeSessionId,
        cwd: approved.cwd,
        prompt: approved.openingPrompt || approved.goalText,
      })
    } finally {
      setBusy(false)
    }
  }

  const onDiscard = () => {
    if (busy) return
    setBusy(true)
    // markCompleted toasts and rolls its own state back on a rejected write.
    void usePromptSessions
      .getState()
      .markCompleted(epic.id, 'EpicApprovalBar discard')
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  return (
    <div data-testid="epic-approval-bar" className="border-t border-butter/40 bg-butter/10 px-[22px] py-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-wide text-fg-dim">
          proposed — not started
        </span>
        <EpicKindTag kind={epic.tag} small />
      </div>
      <p className="mb-2.5 max-w-[760px] text-[12.5px] leading-relaxed text-fg-dim">
        Filed for you to decide on. Nothing has run and nothing has been spent. Approving sends the objective
        above as this Epic&apos;s first prompt.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="epic-approve"
          onClick={onApprove}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-[12.5px] font-semibold text-bg-hi hover:bg-accent-dark disabled:opacity-50"
        >
          Approve &amp; start
        </button>
        <button
          type="button"
          data-testid="epic-discard"
          onClick={onDiscard}
          disabled={busy}
          className="rounded-md border border-line bg-bg-hi px-3.5 py-2 text-[12.5px] font-semibold text-fg-dim hover:bg-bg-elev disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  )
}
