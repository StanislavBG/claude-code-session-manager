import { useEffect, useMemo, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useKnownProjects, candidatePath } from '../../lib/useKnownProjects'
import { compactPath } from '../../lib/compactPath'
import { AttachTray, attachPastedFiles, resolveAttachmentPaths, useAttachments } from './attachments'
import { composeEpicIntake } from '../../lib/epicIntake'
import { useChat } from '../../state/chat'
import { toast } from '../../state/toast'
import { computeGroundingBoard, type GroundingGroup } from '../../lib/groundingBoard'
import { agentTagDef } from '../../lib/agentTagDefs'
import type { AgentPersona } from '../../../preload/api'

// Tag list + labels only — deliberately hardcoded and scoped to 3 (see
// agentTagDefs.ts's AGENT_TAG_ORDER doc comment: 'build' and
// 'project-home-builder' each have their own dedicated creation entry point
// elsewhere, so they're never hand-picked here). The MISSION TEXT itself is
// never a second copy, though — every description below reads through
// `agentTagDef(tag).description`, the same single source TagLibrary.tsx and
// epicIntake.ts's grounding template both use, so this picker can drift on
// which tags it exposes but never on what a tag actually means.
const KIND_OPTIONS: Array<{ tag: NonNullable<PromptSession['tag']>; label: string }> = [
  { tag: 'feature', label: 'Feature' },
  { tag: 'bug', label: 'Bug' },
  { tag: 'discussion', label: 'Discussion' },
]

/** Deterministic dot color per agent name, same hashed-palette idea
 *  sched-primitives.tsx's ProjectTag uses for project dots — a stable,
 *  content-derived color rather than a fixed per-row index (so the same
 *  persona always gets the same dot across renders/sessions). */
const AGENT_DOT_PALETTE = ['#b85c34', '#a3441f', '#6f7d52', '#8a7a60', '#7a6a8a', '#5f7a7d', '#c96442', '#4f7d72']
function agentDot(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AGENT_DOT_PALETTE[h % AGENT_DOT_PALETTE.length]
}

/**
 * Centered New Epic creation card — replaces ProjectsLanding's "New starting
 * prompt" form, rendered in the right pane (not a modal). Two independent
 * selections ground the session: AGENT (who runs it — Agent Library, left
 * column) and MISSION (what it's for — Tag Library, right column), never one
 * conflated picker. An "advanced" toggle flips the card to a read-only
 * grounding board (lib/groundingBoard.ts) showing the real System/Project/
 * Local context this Epic's session will load. Design:
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
  const allEpics = usePromptSessions((s) => s.sessions)
  const { rows, enriched } = useKnownProjects()
  const tabs = useSessions((s) => s.tabs)
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
  // '' means "default agent" — a real, selectable third option, not an unset
  // field, so the row always shows a definite choice alongside Mission.
  const [agentName, setAgentName] = useState('')
  const [agents, setAgents] = useState<AgentPersona[] | null>(null)
  const att = useAttachments()
  const [creating, setCreating] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [home, setHome] = useState<string | null>(null)
  const [board, setBoard] = useState<GroundingGroup[] | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await window.api.agents.listPersonas()
        if (!cancelled) setAgents(list)
      } catch (e) {
        if (!cancelled) {
          setAgents([])
          toast.error((e as Error).message || 'failed to load Agent Library')
        }
      }
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const h = await window.api.app.homeDir()
        if (!cancelled) setHome(h)
      } catch { /* grounding board simply stays unavailable until "advanced" needs it */ }
    })()
    return () => { cancelled = true }
  }, [])

  const selectedAgent = agents?.find((a) => a.name === agentName) ?? null

  const effectiveCwd = cwd || (activeTabCwd && knownCwds.includes(activeTabCwd) ? activeTabCwd : '') || knownCwds[0] || ''
  const trimmedGoal = goal.trim()
  const canCreate = Boolean(effectiveCwd && trimmedGoal)
  // Epics are always created from within a tab's project context — the
  // selector only earns its place on screen when that context is missing
  // (no active tab, or its cwd isn't a known project). Otherwise it's a
  // second way to change something already decided by which tab is open.
  const showProjectSelector = !(activeTabCwd && knownCwds.includes(activeTabCwd))

  // Grounding board is real data (fs reads + existing store counts, never
  // fabricated) — computed lazily, only once "advanced" is opened, and
  // refreshed whenever the two things that change what it reads (project,
  // chosen agent) move underneath it.
  useEffect(() => {
    if (!advanced || !home || !effectiveCwd) return
    let cancelled = false
    computeGroundingBoard({
      home,
      cwd: effectiveCwd,
      agentPersonaPath: selectedAgent?.path ?? null,
      agentPersonaName: selectedAgent?.name ?? null,
      openTerminalTabsInProject: tabs.filter((t) => t.cwd === effectiveCwd).length,
      otherEpicsInProject: Object.values(allEpics).filter((e) => e.cwd === effectiveCwd).length,
    })
      .then((g) => { if (!cancelled) setBoard(g) })
      .catch((e) => { if (!cancelled) toast.error((e as Error).message || 'failed to read grounding sources') })
    return () => { cancelled = true }
  }, [advanced, home, effectiveCwd, selectedAgent, tabs, allEpics])

  const resetForm = () => {
    setCwd('')
    setTitle('')
    setGoal('')
    setTag('feature')
    setAgentName('')
    setAdvanced(false)
    setBoard(null)
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
    const { goalText, openingPrompt } = composeEpicIntake({
      title,
      goal,
      referencePaths,
      tag,
      agentName: selectedAgent?.name,
      agentDescription: selectedAgent?.description ?? undefined,
    })
    // Every Epic is BORN 'proposed'; nothing is created directly as 'active'.
    // Submitting this form is not a second kind of creation — it is the one
    // 'proposed -> active' transition, the same one EpicApprovalBar's
    // Approve & start takes. createPromptSession can only ever mint
    // 'proposed', so this call and the approveProposed below are what perform
    // that transition.
    // See prompt-sessions/README.md#lifecycle.
    const session = selectedAgent
      ? createPromptSession(effectiveCwd, goalText, tag, 'NewEpicCard', selectedAgent.name)
      : createPromptSession(effectiveCwd, goalText, tag, 'NewEpicCard')
    approveProposed(session.id, 'NewEpicCard')
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

  const selectedTagMission = agentTagDef(tag).description
  const sourceCount = board ? board.reduce((n, g) => n + g.items.filter((i) => i.present).length, 0) : 0
  const tokenTotal = board ? board.reduce((n, g) => n + g.items.reduce((s, i) => s + i.tokK, 0), 0) : 0

  return (
    <section className="flex-1 min-w-0 grid place-items-center overflow-y-auto bg-bg p-8" data-testid="new-epic-card">
      <div
        className="w-full transition-[max-width] duration-500"
        style={{ maxWidth: advanced ? 860 : 660, perspective: 2400 }}
      >
        <div
          className="relative w-full transition-transform duration-500"
          style={{ transformStyle: 'preserve-3d', transform: advanced ? 'rotateY(180deg)' : 'none' }}
        >
          {/* front */}
          <div
            className="rounded-2xl border border-line bg-bg-hi px-[26px] pb-[22px] pt-6"
            style={{ backfaceVisibility: 'hidden', position: advanced ? 'absolute' : 'static', inset: 0 }}
          >
            <NewEpicHeader eyebrow="New Epic" advanced={advanced} setAdvanced={setAdvanced} />
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

            <div className="mb-3.5 grid grid-cols-2 gap-3.5">
              <div>
                <div
                  className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint"
                  title="Who runs this Epic — from the Agent Library (~/.claude/agents)."
                >
                  1 · agent — who is working
                </div>
                <div className="grid gap-1">
                  <button
                    type="button"
                    data-testid="new-epic-agent-default"
                    onClick={() => setAgentName('')}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left ${
                      agentName === '' ? 'border-accent bg-bg-elev' : 'border-line bg-bg'
                    }`}
                  >
                    <span className="h-1.5 w-1.5 rotate-45 rounded-sm bg-fg-faint" />
                    <span className="font-mono text-xs font-medium text-fg">Default</span>
                  </button>
                  {(agents ?? []).map((a) => {
                    const on = agentName === a.name
                    return (
                      <button
                        key={a.name}
                        type="button"
                        data-testid={`new-epic-agent-${a.name}`}
                        onClick={() => setAgentName(a.name)}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left ${
                          on ? 'border-accent bg-bg-elev' : 'border-line bg-bg'
                        }`}
                      >
                        <span className="h-1.5 w-1.5 rotate-45 rounded-sm" style={{ background: agentDot(a.name) }} />
                        <span className={`font-mono text-xs ${on ? 'font-semibold' : 'font-medium'} text-fg`}>{a.name}</span>
                        {a.description && (
                          <span className="ml-auto truncate whitespace-nowrap text-[11px] text-fg-faint">{a.description}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div>
                <div
                  className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint"
                  title="The Epic's mission — from the Tag Library. Sets how eagerly /develop fires."
                >
                  2 · mission — how they work
                </div>
                <div className="flex flex-wrap gap-1">
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
                </div>
                <div className="mt-2 border-l-2 border-accent-muted pl-2.5 text-[12.5px] leading-[1.5] text-fg-dim">
                  {selectedTagMission}
                  <div className="mt-1 font-mono text-[11px] text-fg-faint">
                    sonnet{selectedAgent ? ` · ${selectedAgent.tools.join(' ') || 'no tool restriction'}` : ''}
                  </div>
                </div>
              </div>
            </div>

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
              <button
                type="button"
                data-testid="new-epic-flip-to-grounding"
                onClick={() => setAdvanced(true)}
                title="See what this Epic's session will actually load"
                className="rounded-md border border-accent-muted bg-bg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-bg-elev"
              >
                ⤺ Grounding{board ? ` · ${sourceCount} sources` : ''}
              </button>
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

          {/* back */}
          <div
            className="rounded-2xl border border-line bg-bg-hi px-[26px] pb-[22px] pt-6"
            style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)', position: advanced ? 'static' : 'absolute', inset: 0 }}
          >
            <NewEpicHeader eyebrow="New Epic · grounding" advanced={advanced} setAdvanced={setAdvanced} />
            <h2 className="m-0 font-serif text-2xl font-semibold tracking-[-0.3px] text-fg">
              What this Epic will know
            </h2>
            <p className="my-2 mb-[18px] text-[13.5px] leading-[1.55] text-fg-dim">
              Every layer of context this Epic's session actually loads before your goal is sent —
              real files this app can read, never a guess. Read-only: session-manager has no way to
              tell the claude CLI to skip one of these once it's on disk.
            </p>

            <div className="mb-3 rounded-[10px] border border-line bg-bg px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-fg">
                  <span className="h-1.5 w-1.5 rotate-45 rounded-sm" style={{ background: selectedAgent ? agentDot(selectedAgent.name) : '#8a7a60' }} />
                  {selectedAgent?.name ?? 'default'}
                </span>
                <span className="text-fg-faint">·</span>
                <span className="rounded-full bg-fg-faint px-2 py-0.5 font-mono text-[11px] font-semibold text-bg-hi">#{tag}</span>
                <span className="ml-auto font-mono text-[11px] text-fg-faint">{tokenTotal.toFixed(1)}k of 200k window (estimate)</span>
              </div>
              <div className="mt-1 text-sm font-semibold text-fg">{title || 'Untitled Epic'}</div>
              <div className="mt-0.5 text-[12.5px] leading-[1.5] text-fg-dim">{goal || selectedTagMission}</div>
            </div>

            {board ? (
              <div className="grid grid-cols-3 gap-2.5">
                {board.map((g) => (
                  <div key={g.key} data-testid={`grounding-group-${g.key}`} className="overflow-hidden rounded-[10px] border border-line bg-bg">
                    <div className="border-b border-rule bg-bg-hi px-2.5 py-2">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[12.5px] font-semibold text-fg">{g.label}</span>
                        <span className="ml-auto font-mono text-[10.5px] text-fg-faint">
                          {g.items.filter((i) => i.present).length}/{g.items.length}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10.5px] text-fg-faint">{g.path}</div>
                    </div>
                    <div>
                      {g.items.map((it, i) => (
                        <div
                          key={it.name}
                          className={`px-2.5 py-1.5 ${i ? 'border-t border-rule' : ''} ${it.present ? '' : 'opacity-60'}`}
                        >
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`grid h-3 w-3 flex-shrink-0 place-items-center rounded ${it.present ? 'bg-accent text-bg-hi' : 'ring-1 ring-inset ring-line'}`}
                            >
                              {it.present ? '✓' : ''}
                            </span>
                            <span className="truncate font-mono text-[11px] text-fg">{it.name}</span>
                            {it.tokK > 0 && (
                              <span className="ml-auto flex-shrink-0 font-mono text-[10.5px] text-fg-faint">{it.tokK.toFixed(1)}k</span>
                            )}
                          </div>
                          <div className="pl-[18px] text-[11px] leading-[1.4] text-fg-faint">
                            {it.detail}{it.locked ? '' : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-[10px] border border-dashed border-rule px-4 py-6 text-center text-[12.5px] text-fg-faint">
                Reading grounding sources…
              </div>
            )}

            <div className="mt-4 flex items-center gap-2.5">
              <button
                type="button"
                data-testid="new-epic-flip-to-goal"
                onClick={() => setAdvanced(false)}
                className="rounded-md border border-accent-muted bg-bg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-bg-elev"
              >
                ⤺ Back to the goal
              </button>
              <span className="ml-auto flex items-center gap-2.5">
                <span className="font-mono text-[11px] text-fg-faint">{sourceCount} sources · {tokenTotal.toFixed(1)}k</span>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="rounded-md border border-line bg-bg px-3.5 py-2 text-[12.5px] font-semibold text-fg-dim hover:bg-bg-elev"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={!canCreate || creating}
                  className="rounded-md bg-accent px-4 py-2 text-[12.5px] font-semibold text-bg-hi disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {creating ? 'Starting…' : 'Start Epic'}
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function NewEpicHeader({
  eyebrow,
  advanced,
  setAdvanced,
}: {
  eyebrow: string
  advanced: boolean
  setAdvanced: (v: boolean) => void
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2.5">
      <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.11em] text-accent">
        {eyebrow}
      </span>
      <span className="ml-auto flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-fg-faint">advanced</span>
        <button
          type="button"
          role="switch"
          aria-checked={advanced}
          data-testid="new-epic-advanced-toggle"
          onClick={() => setAdvanced(!advanced)}
          className={`flex h-[19px] w-[34px] items-center rounded-full p-0.5 ${advanced ? 'justify-end bg-accent' : 'justify-start bg-rule'}`}
        >
          <span className="h-[15px] w-[15px] rounded-full bg-bg-hi shadow" />
        </button>
      </span>
    </div>
  )
}
