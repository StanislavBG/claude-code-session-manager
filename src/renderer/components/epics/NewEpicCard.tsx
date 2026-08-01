import { useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useKnownProjects, candidatePath } from '../../lib/useKnownProjects'
import { compactPath } from '../../lib/compactPath'
import { AttachTray, attachPastedFiles, resolveAttachmentPaths, useAttachments } from './attachments'
import { composeEpicIntake } from '../../lib/epicIntake'
import { useChat } from '../../state/chat'

const KIND_OPTIONS: Array<{ tag: NonNullable<PromptSession['tag']>; label: string }> = [
  { tag: 'feature', label: 'Feature' },
  { tag: 'bug', label: 'Bug' },
  { tag: 'discussion', label: 'Discussion' },
]

/**
 * Centered New Epic creation card — replaces ProjectsLanding's "New starting
 * prompt" form, rendered in the right pane (not a modal). Design:
 * session-manager-operations/design-mocks/epics/DESIGN_SPEC.md §"New Epic card".
 */
export function NewEpicCard({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void
  onCancel: () => void
}) {
  const createPromptSession = usePromptSessions((s) => s.createPromptSession)
  const approveProposed = usePromptSessions((s) => s.approveProposed)
  const { rows, enriched } = useKnownProjects()
  const activeTabCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)

  const knownCwds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const row of rows) {
      const cwd = enriched[row.encoded]?.cwd ?? candidatePath(row.encoded)
      if (!cwd || seen.has(cwd)) continue
      seen.add(cwd)
      out.push(cwd)
    }
    return out
  }, [rows, enriched])

  const [cwd, setCwd] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [tag, setTag] = useState<NonNullable<PromptSession['tag']>>('feature')
  const att = useAttachments()
  const [creating, setCreating] = useState(false)

  const effectiveCwd = cwd || (activeTabCwd && knownCwds.includes(activeTabCwd) ? activeTabCwd : '') || knownCwds[0] || ''
  const trimmedGoal = goal.trim()
  const canCreate = Boolean(effectiveCwd && trimmedGoal)
  // Epics are always created from within a tab's project context — the
  // selector only earns its place on screen when that context is missing
  // (no active tab, or its cwd isn't a known project). Otherwise it's a
  // second way to change something already decided by which tab is open.
  const showProjectSelector = !(activeTabCwd && knownCwds.includes(activeTabCwd))

  const resetForm = () => {
    setCwd('')
    setTitle('')
    setGoal('')
    setTag('feature')
    att.clear()
  }

  const handleCreate = async () => {
    if (!canCreate || creating) return
    setCreating(true)
    try {
    // goalText and the opening prompt come from one composer (lib/epicIntake)
    // so the Epic's stored identity and the message the agent actually reads
    // can't drift. Both are written exactly once: an Epic's title/objective
    // are fixed for the life of its session by design — iteration happens in
    // follow-up messages, not by rewriting the goal.
    // Pasted-clipboard images have no filesystem path until they are saved,
    // so resolve every attachment to a real path BEFORE folding it into the
    // goal text — otherwise the reference line names a file that never
    // existed (PRD 865).
    const referencePaths = await resolveAttachmentPaths(att.items, effectiveCwd)
    const { goalText, openingPrompt } = composeEpicIntake({ title, goal, referencePaths, tag })
    // Every Epic is BORN 'proposed'; nothing is created directly as 'active'.
    // Submitting this form is not a second kind of creation — it is the one
    // 'proposed -> active' transition, the same one EpicApprovalBar's
    // Approve & start takes. Creating it 'active' (the createPromptSession
    // default) set the state as a side effect of creation and meant the New
    // Epic path never went through that shared transition at all.
    // See prompt-sessions/README.md#lifecycle.
    const session = createPromptSession(effectiveCwd, goalText, tag, 'proposed')
    approveProposed(session.id)
    // Send the objective straight into the Epic's session, so it opens already
    // waiting on the agent — the user has just typed the goal, there is
    // nothing further for them to enter. Chat (not PRD dispatch) on purpose:
    // the first turn is the agent's response, which the user then acts on.
    useChat.getState().send({
      tabId: session.id,
      sessionId: session.claudeSessionId,
      cwd: effectiveCwd,
      prompt: openingPrompt,
    })
    resetForm()
    onCreated(session.id)
    } finally {
      setCreating(false)
    }
  }

  const handleCancel = () => {
    resetForm()
    onCancel()
  }

  return (
    <section className="flex-1 min-w-0 grid place-items-center overflow-y-auto bg-bg p-8" data-testid="new-epic-card">
      <div className="w-full max-w-[620px] rounded-2xl border border-line bg-bg-hi px-[26px] pb-[22px] pt-6">
        <div className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.11em] text-accent">
          New Epic
        </div>
        <h2 className="m-0 font-serif text-2xl font-semibold tracking-[-0.3px] text-fg">
          What are we trying to achieve?
        </h2>
        <p className="my-2 mb-[18px] text-[13.5px] leading-[1.55] text-fg-dim">
          One goal per Epic — fixed for the life of its session. The title and objective are sent
          as the first message the moment you start it, so the agent is already working when it opens.
        </p>

        {showProjectSelector ? (
          <label className="mb-2.5 flex flex-col gap-1">
            <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint">
              Project
            </span>
            <select
              data-testid="new-prompt-cwd"
              value={effectiveCwd}
              onChange={(e) => setCwd(e.target.value)}
              className="rounded-md border border-line bg-bg px-2 py-1.5 font-mono text-[12.5px] text-fg"
            >
              {knownCwds.length === 0 && <option value="">No known projects</option>}
              {knownCwds.map((c) => (
                <option key={c} value={c}>{compactPath(c)}</option>
              ))}
            </select>
          </label>
        ) : (
          <div
            data-testid="new-prompt-cwd-static"
            className="mb-2.5 flex items-center gap-1.5 font-mono text-[11px] text-fg-faint"
          >
            <span className="uppercase tracking-[0.09em]">Project</span>
            <span className="text-fg-dim">{compactPath(effectiveCwd)}</span>
          </div>
        )}

        <input
          data-testid="new-epic-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPaste={(e) => attachPastedFiles(e, att)}
          placeholder="Epic title"
          className="mb-2 w-full appearance-none rounded-[10px] border border-line bg-bg px-[13px] py-[11px] text-sm font-semibold text-fg outline-none"
        />
        <textarea
          data-testid="new-epic-goal"
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onPaste={(e) => attachPastedFiles(e, att)}
          placeholder="The objective, in a sentence or two — this is sent as the first instruction."
          className="mb-3 w-full resize-y appearance-none rounded-[10px] border border-line bg-bg px-[13px] py-[11px] text-[13px] leading-[1.55] text-fg outline-none"
        />

        <div className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint">
          references{att.items.length ? ` · ${att.items.length}` : ''}
        </div>
        <AttachTray att={att} tall testId="new-epic-attach-tray" />

        <div className="mt-4 flex items-center gap-2.5">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint">
            type
          </span>
          <span className="flex gap-0.5">
            {KIND_OPTIONS.map((opt) => {
              const on = tag === opt.tag
              return (
                <button
                  key={opt.tag}
                  type="button"
                  data-testid={`new-epic-kind-${opt.tag}`}
                  onClick={() => setTag(opt.tag)}
                  className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                    on ? 'bg-bg text-fg ring-1 ring-inset ring-line font-semibold' : 'text-fg-faint'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </span>
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              data-testid="new-epic-cancel"
              onClick={handleCancel}
              className="rounded-md border border-line bg-bg px-3.5 py-2 text-[12.5px] font-semibold text-fg-dim hover:bg-bg-elev"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="new-epic-create"
              onClick={() => void handleCreate()}
              disabled={!canCreate || creating}
              className="rounded-md bg-accent px-4 py-2 text-[12.5px] font-semibold text-bg-hi disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating ? 'Starting…' : 'Start Epic'}
            </button>
          </span>
        </div>
      </div>
    </section>
  )
}
