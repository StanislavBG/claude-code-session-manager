/**
 * Inbound auto-approve — the EpicApprovalBar "Approve & start" act without the
 * button. Main (crossProjectFeedback.cjs) stamps `source.autoApprove` only after
 * verifying the human explicitly asked for the cross-project work; this module
 * approves + starts exactly those Epics and nothing else. Stores are touched via
 * getState() only (renderer stores are islands).
 */
import { usePromptSessions, type PromptSession } from '../state/promptSessions'
import { useChat } from '../state/chat'
import { toast } from '../state/toast'

type SendOrigin = NonNullable<Parameters<ReturnType<typeof useChat.getState>['send']>[0]['origin']>

/** Same act as EpicApprovalBar.onApprove. Returns the approved session, or null. */
export function approveAndStart(epic: PromptSession, source: string, origin: SendOrigin): PromptSession | null {
  const approved = usePromptSessions.getState().approveProposed(epic.id, source)
  if (!approved) {
    toast.error('This session is no longer awaiting approval.')
    return null
  }
  useChat.getState().send({
    tabId: approved.id,
    sessionId: approved.claudeSessionId,
    cwd: approved.cwd,
    prompt: approved.openingPrompt || approved.goalText,
    origin,
  })
  return approved
}

function isStampedInbound(e: PromptSession): boolean {
  return (
    e.status === 'proposed' &&
    e.source?.producer === 'cross-project-feedback' &&
    (e.source.autoApprove?.requestedBy === 'human' || e.source.autoApprove?.requestedBy === 'macro')
  )
}

/** Approve-and-start every stamped inbound proposal already in the store (only `epicId` when given). No hydrate. */
export function approveStampedInbound(cwd: string, epicId?: string): void {
  const candidates = Object.values(usePromptSessions.getState().sessions).filter(
    (e) => e.cwd === cwd && (epicId === undefined || e.id === epicId) && isStampedInbound(e),
  )
  for (const epic of candidates) approveAndStart(epic, 'inbound-auto-approve', 'inbound-proposal')
}

/** Hydrate `cwd`'s Epics, then approve-and-start every stamped inbound proposal. */
export async function autoApproveInbound(cwd: string, epicId?: string): Promise<void> {
  await usePromptSessions.getState().hydrate(cwd)
  approveStampedInbound(cwd, epicId)
}
