import { useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useKnownProjects, candidatePath } from '../../lib/useKnownProjects'
import { compactPath } from '../../lib/compactPath'
import { AttachTray, useAttachments } from './attachments'

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

  const effectiveCwd = cwd || (activeTabCwd && knownCwds.includes(activeTabCwd) ? activeTabCwd : '') || knownCwds[0] || ''
  const trimmedGoal = goal.trim()
  const canCreate = Boolean(effectiveCwd && trimmedGoal)

  const resetForm = () => {
    setCwd('')
    setTitle('')
    setGoal('')
    setTag('feature')
    att.clear()
  }

  const handleCreate = () => {
    if (!canCreate) return
    // File names are user/filesystem controlled and can contain newlines —
    // strip them so a crafted name can't inject a fake extra "Reference:"
    // line (or otherwise forge structure) into goalText.
    const singleLine = (s: string) => s.replace(/\r?\n/g, ' ')
    const trimmedTitle = singleLine(title.trim())
    const bodyText = trimmedTitle ? `${trimmedTitle}\n\n${trimmedGoal}` : trimmedGoal
    const referenceLines = att.items.map((i) => `Reference: ${singleLine(i.path)}`)
    const goalText = referenceLines.length ? `${bodyText}\n\n${referenceLines.join('\n')}` : bodyText
    const session = createPromptSession(effectiveCwd, goalText, tag)
    resetForm()
    onCreated(session.id)
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
          One goal per Epic. Its discussion, PRDs and agent runs all stay inside it.
        </p>

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

        <input
          data-testid="new-epic-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Epic title"
          className="mb-2 w-full appearance-none rounded-[10px] border border-line bg-bg px-[13px] py-[11px] text-sm font-semibold text-fg outline-none"
        />
        <textarea
          data-testid="new-epic-goal"
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="The goal, in a sentence or two — what done looks like."
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
              onClick={handleCreate}
              disabled={!canCreate}
              className="rounded-md bg-accent px-4 py-2 text-[12.5px] font-semibold text-bg-hi disabled:cursor-not-allowed disabled:opacity-40"
            >
              Create Epic
            </button>
          </span>
        </div>
      </div>
    </section>
  )
}
