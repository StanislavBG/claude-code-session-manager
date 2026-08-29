import { useEffect, useMemo, useRef, useState } from 'react'
import { usePromptSessions, type PromptSession } from '../../state/promptSessions'
import { useSessions } from '../../state/sessions'
import { useKnownProjects } from '../../lib/useKnownProjects'
import { compactPath } from '../../lib/compactPath'
import { resolveEpicProject } from '../../lib/epicProjectScope'
import { AttachButton, AttachTray, attachPastedFiles, resolveAttachmentPaths, useAttachments } from './attachments'
import { composeEpicIntake } from '../../lib/epicIntake'
import { useChat } from '../../state/chat'
import { toast } from '../../state/toast'
import { computeGroundingBoard, summarizeGroundingBoard, type GroundingGroup } from '../../lib/groundingBoard'
import { agentTagDef } from '../../lib/agentTagDefs'
import { tagLibraryEntry, TAG_GROUP_ORDER, type EpicTag } from '../../lib/tagLibrary'
import { CONTEXT_INJECTIONS, CONTEXT_INJECTION_ORDER, type ContextInjectionKey } from '../../lib/contextInjections'
import { Badge } from '../ui/Badge'
import type { AgentPersona, DelegationReadiness } from '../../../preload/api'

/** Missions offered when the selected persona declares no `tags:` of its own
 *  (or the Agent Library is empty) — the three general-purpose ones. */
const FALLBACK_MISSION_TAGS: EpicTag[] = ['feature', 'bug', 'discussion']

/**
 * Default on/off state for every Context Injection, given the currently
 * selected Mission tag. `general-behavior` is the universal floor and is
 * always on. `delegate-implementation` defaults on only for `feature`/`bug`
 * — the missions whose own Mission template already tells the agent to
 * queue work via /develop — and off otherwise (e.g. `discussion`, where no
 * implementation is expected). A human toggle always overrides this default
 * (see `injectionOverrides` below); this function only supplies the
 * fallback for keys the human hasn't touched.
 */
function defaultContextInjectionsForTag(t: EpicTag): Record<ContextInjectionKey, boolean> {
  return Object.fromEntries(
    CONTEXT_INJECTION_ORDER.map((k) => [k, k === 'delegate-implementation' ? t === 'feature' || t === 'bug' : true]),
  ) as Record<ContextInjectionKey, boolean>
}

/**
 * Which missions this Epic may be given, derived from the SELECTED persona's
 * own `tags:` frontmatter (AgentPersona.tags — the same many-to-many
 * membership TagLibrary.tsx and AgentLibrary.tsx both edit through
 * savePersona) rather than a hardcoded 3-tag list. Agent and Mission remain
 * two independent axes, but not every mission belongs to every actor:
 * `builder` carries only `build`, `project-home-builder` only
 * `project-home-builder`, `architect` feature/bug/discussion — so the pills
 * change when the agent changes. Unknown tag strings in a persona file are
 * dropped rather than crashing tagLibraryEntry(); labels and mission text
 * still come from TAG_LIBRARY / agentTagDef, never a second copy.
 */
function missionTagsForAgent(agent: AgentPersona | null): EpicTag[] {
  const known = (agent?.tags ?? []).filter((t): t is EpicTag => TAG_GROUP_ORDER.includes(t as EpicTag))
  return known.length ? known : FALLBACK_MISSION_TAGS
}

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

/** Fixed department display order, mid-startup shape (decided 2026-08-02) —
 *  Engineering leads/executors first (most-picked), specialist reviewers
 *  fold into Engineering too (same department, narrower title), then the
 *  other functions in roughly headcount order for a small shop. Any
 *  persona whose `title` doesn't parse as "<Department> — <role>" (or has
 *  no title at all) falls into its own trailing "Other" group rather than
 *  being silently dropped. */
const DEPARTMENT_ORDER = ['Engineering', 'Product', 'Design', 'Quality', 'Platform', 'Growth']

/** Groups personas by the department prefix of their `title` field
 *  ("<Department> — <role>"), in DEPARTMENT_ORDER, with anything
 *  untitled/unrecognized collected into a trailing "Other" group. Pure —
 *  no IO, safe to call on every render. */
function groupAgentsByDepartment(agents: AgentPersona[]): Array<{ department: string; agents: AgentPersona[] }> {
  const byDept = new Map<string, AgentPersona[]>()
  for (const a of agents) {
    const dept = a.title?.split(' — ')[0]?.trim() || 'Other'
    if (!byDept.has(dept)) byDept.set(dept, [])
    byDept.get(dept)!.push(a)
  }
  const known = DEPARTMENT_ORDER.filter((d) => byDept.has(d)).map((department) => ({ department, agents: byDept.get(department)! }))
  const unknown = [...byDept.keys()].filter((d) => !DEPARTMENT_ORDER.includes(d)).sort()
    .map((department) => ({ department, agents: byDept.get(department)! }))
  return [...known, ...unknown]
}

/** One persona row. Same shape whether it's the pinned "who is working" tile
 *  or one of the alternatives below it — the pinned one deliberately carries
 *  NO accent ring: sitting under "1 · agent — who is working", separated from
 *  "available agents by role", is already the whole selection signal. */
function AgentTile({ agent, pinned, onPick }: { agent: AgentPersona; pinned: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      data-testid={`new-epic-agent-${agent.name}`}
      data-selected={pinned ? 'true' : 'false'}
      onClick={onPick}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-left ${
        pinned ? 'bg-bg-elev' : 'bg-bg'
      }`}
    >
      <span className="h-1.5 w-1.5 flex-shrink-0 rotate-45 rounded-sm" style={{ background: agentDot(agent.name) }} />
      <span className={`flex-shrink-0 font-mono text-xs ${pinned ? 'font-semibold' : 'font-medium'} text-fg`}>{agent.name}</span>
      {agent.title && (
        <span className="flex-shrink-0 text-[10.5px] text-fg-faint">{agent.title.split(' — ')[1]}</span>
      )}
      {agent.description && (
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-fg-faint">{agent.description}</span>
      )}
    </button>
  )
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
  const { projects } = useKnownProjects()
  const tabs = useSessions((s) => s.tabs)
  const activeTabCwd = useSessions((s) => s.tabs.find((t) => t.id === s.activeTabId)?.cwd ?? null)

  // One entry per real working directory. Previously this deduped over
  // `enriched[...]?.cwd ?? candidatePath(row.encoded)`, so every unresolvable
  // transcript folder contributed a FABRICATED path — thousands of phantom
  // "projects" to hydrate Epics for. See lib/knownProjectAggregate.ts.
  const knownCwds = useMemo(() => projects.map((p) => p.cwd), [projects])

  const [cwd, setCwd] = useState('')
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [tag, setTag] = useState<NonNullable<PromptSession['tag']>>('feature')
  // '' only until the Agent Library resolves (or when it is genuinely empty) —
  // there is no "Default" pseudo-agent, the real 'architect' persona is the
  // default pick, so the pinned "who is working" tile always names a real one.
  const [agentName, setAgentName] = useState('')
  const [agents, setAgents] = useState<AgentPersona[] | null>(null)
  // Tracks whether the human has clicked an Agent chip, so the async
  // 'architect' default (set once listPersonas() resolves) never clobbers
  // a manual pick made before or after that resolution.
  const agentTouchedRef = useRef(false)
  const att = useAttachments()
  const [creating, setCreating] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [home, setHome] = useState<string | null>(null)
  const [board, setBoard] = useState<GroundingGroup[] | null>(null)
  // "Can this project actually delegate?" (delegation-readiness-probe) —
  // fetched once per card mount, never polled. `null` covers both "not
  // fetched yet" and "probe failed" (unknown), so a missing/erroring IPC
  // surface just renders no indicator rather than a broken card.
  const [readiness, setReadiness] = useState<DelegationReadiness | null>(null)
  // Context Injections (contextInjections.ts) — Session-Manager-authored
  // text, independent of Actor/Input/Mission, each its own on/off toggle.
  // Only an explicit human toggle is stored; the displayed/used value is
  // always `defaultContextInjectionsForTag(tag)` overridden by that map, so
  // there is one source of truth per key instead of a stored value plus a
  // synchronization effect fighting over it — a tag change simply changes
  // what an UNtouched key falls back to.
  const [injectionOverrides, setInjectionOverrides] = useState<Partial<Record<ContextInjectionKey, boolean>>>({})
  const contextInjectionsOn = useMemo<Record<ContextInjectionKey, boolean>>(
    () => ({ ...defaultContextInjectionsForTag(tag), ...injectionOverrides }),
    [tag, injectionOverrides],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await window.api.agents.listPersonas()
        if (!cancelled) {
          setAgents(list)
          const preferred = list.find((a) => a.name === 'architect') ?? list[0]
          if (!agentTouchedRef.current && preferred) setAgentName(preferred.name)
        }
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
  const missionTags = missionTagsForAgent(selectedAgent)
  const missionKey = missionTags.join(',')

  // Missions are conditional on the Actor, so switching agent can invalidate
  // the currently-picked mission (architect's 'feature' -> builder, which
  // carries only 'build'): snap to that agent's first mission when the current
  // one isn't one of theirs.
  useEffect(() => {
    const allowed = missionKey.split(',') as EpicTag[]
    if (!allowed.includes(tag)) setTag(allowed[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionKey])

  // Epics are always created from within a tab's project context, and that
  // context is the tab's cwd ALONE — never filtered through the
  // transcript-derived known-projects list, which a brand-new project is
  // legitimately missing from until its first session is written. See
  // lib/epicProjectScope.ts. The selector only earns its place on screen when
  // there is no active tab at all; otherwise it's a second way to change
  // something already decided by which tab is open.
  const { cwd: effectiveCwd, showSelector: showProjectSelector } = resolveEpicProject({
    picked: cwd,
    activeTabCwd,
    knownCwds,
  })
  const trimmedGoal = goal.trim()
  const canCreate = Boolean(effectiveCwd && trimmedGoal)

  useEffect(() => {
    if (!effectiveCwd) return
    let cancelled = false
    Promise.resolve(window.api.app?.delegationReadiness?.(effectiveCwd)).then(
      (r) => { if (!cancelled && r) setReadiness(r) },
      () => { if (!cancelled) setReadiness(null) },
    )
    return () => { cancelled = true }
    // Fetched once per mount (first time effectiveCwd is known), not
    // re-polled on every later cwd/tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    agentTouchedRef.current = false
    setAgentName((agents?.find((a) => a.name === 'architect') ?? agents?.[0])?.name ?? '')
    setAdvanced(false)
    setBoard(null)
    setInjectionOverrides({})
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
    // AIM's "Input" line: reuse the cached grounding board if "advanced" was
    // already opened; otherwise compute it fresh here (same real fs/IPC
    // reads the board UI performs, no separate code path) so every Epic
    // states what it's grounded in, not just the ones where the human
    // happened to flip the card open.
    const groundingForPrompt =
      board ??
      (home
        ? await computeGroundingBoard({
            home,
            cwd: effectiveCwd,
            agentPersonaPath: selectedAgent?.path ?? null,
            agentPersonaName: selectedAgent?.name ?? null,
            openTerminalTabsInProject: tabs.filter((t) => t.cwd === effectiveCwd).length,
            otherEpicsInProject: Object.values(allEpics).filter((e) => e.cwd === effectiveCwd).length,
          }).catch(() => null)
        : null)
    const { goalText, openingPrompt, sections } = composeEpicIntake({
      title,
      goal,
      referencePaths,
      tag,
      agentName: selectedAgent?.name,
      agentDescription: selectedAgent?.description ?? undefined,
      inputSummary: groundingForPrompt ? summarizeGroundingBoard(groundingForPrompt, readiness) : undefined,
      contextInjections: contextInjectionsOn,
    })
    // Every Epic is BORN 'proposed'; nothing is created directly as 'active'.
    // Submitting this form is not a second kind of creation — it is the one
    // 'proposed -> active' transition, the same one EpicApprovalBar's
    // Approve & start takes. createPromptSession can only ever mint
    // 'proposed', so this call and the approveProposed below are what perform
    // that transition.
    // See prompt-sessions/README.md#lifecycle.
    // openingPrompt/sections are persisted on the Epic (not just sent into
    // chat below) so its first turn can render as a structured AIM briefing
    // card rather than only a flat prose bubble — see EpicIntakeCard.
    const session = selectedAgent
      ? await createPromptSession(effectiveCwd, goalText, tag, 'NewEpicCard', selectedAgent.name, openingPrompt, sections)
      : await createPromptSession(effectiveCwd, goalText, tag, 'NewEpicCard', undefined, openingPrompt, sections)
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
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
    <section className="flex-1 min-w-0 grid place-items-center overflow-y-auto bg-bg p-6" data-testid="new-epic-card">
      <div
        className="w-full transition-[max-width] duration-500"
        style={{ maxWidth: advanced ? 'min(1320px, 94vw)' : 'min(920px, 92vw)', perspective: 2400 }}
      >
        {/* Fixed-height perspective box — both faces are always position:absolute
            inset:0 inside it (never toggled with `static`), so the card never
            resizes/jumps mid-flip and the two faces can never visually overlap.
            Each face scrolls its own body independently when content is tall. */}
        <div
          className="relative w-full transition-transform duration-500"
          style={{
            height: 'min(760px, 84vh)',
            transformStyle: 'preserve-3d',
            transform: advanced ? 'rotateY(180deg)' : 'none',
          }}
        >
          {/* front */}
          <div
            data-testid="new-epic-front"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files.length) att.add(e.dataTransfer.files)
            }}
            className={`absolute inset-0 flex flex-col rounded-2xl border bg-bg-hi px-[26px] pt-6 pb-[18px] ${
              dragOver ? 'border-accent' : 'border-line'
            }`}
            style={{ backfaceVisibility: 'hidden' }}
          >
            <NewEpicHeader eyebrow="New session" advanced={advanced} setAdvanced={setAdvanced} />
            <h2 className="m-0 font-serif text-2xl font-semibold tracking-[-0.3px] text-fg">
              What are we trying to achieve?
            </h2>
            <p className="my-2 mb-[18px] text-[13.5px] leading-[1.55] text-fg-dim">
              One goal per Epic — fixed for the life of its session. The title and objective are sent
              as the first message the moment you start it, so the agent is already working when it opens.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">

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

            {readiness && !readiness.ok && (
              <div
                data-testid="delegation-readiness-warning"
                className="mb-2.5 rounded-md border border-honey/30 bg-honey/15 px-2.5 py-2 text-[11.5px] leading-[1.5]"
              >
                <Badge tone="warn">Delegation not ready</Badge>
                <ul className="mt-1.5 list-disc pl-4 text-fg-dim">
                  {readiness.checks.filter((c) => !c.ok).map((c) => (
                    <li key={c.id} data-testid={`delegation-readiness-check-${c.id}`}>
                      <span className="font-medium text-fg">{c.label}</span>
                      {c.fix && <span className="text-fg-faint"> — {c.fix}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mb-3.5 grid grid-cols-2 gap-3.5">
              <div className="min-w-0">
                <div
                  className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint"
                  title="Who runs this session — from the Agent Library (~/.claude/agents)."
                >
                  1 · agent — who is working
                </div>
                <div className="grid min-w-0 gap-1">
                  {selectedAgent && (
                    <AgentTile agent={selectedAgent} pinned onPick={() => {}} />
                  )}
                  {(agents ?? []).length > 0 && (
                    <div className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-faint">
                      available agents by role
                    </div>
                  )}
                  {groupAgentsByDepartment((agents ?? []).filter((a) => a.name !== agentName)).map((group) => (
                    <div key={group.department} className="contents">
                      <div className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-fg-faint">
                        {group.department}
                      </div>
                      {group.agents.map((a) => (
                        <AgentTile
                          key={a.name}
                          agent={a}
                          pinned={false}
                          onPick={() => {
                            agentTouchedRef.current = true
                            setAgentName(a.name)
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              <div className="min-w-0">
                <div
                  className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint"
                  title="The session's mission — from the Tag Library. Sets how eagerly /develop fires."
                >
                  2 · mission — how they work
                </div>
                <div className="flex flex-wrap gap-1">
                  {missionTags.map((t) => {
                    const on = tag === t
                    return (
                      <button
                        key={t}
                        type="button"
                        data-testid={`new-epic-kind-${t}`}
                        onClick={() => setTag(t)}
                        className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                          on ? 'bg-bg text-fg ring-1 ring-inset ring-line font-semibold' : 'text-fg-faint'
                        }`}
                      >
                        {tagLibraryEntry(t).label}
                      </button>
                    )
                  })}
                </div>
                <div className="mt-2 border-l-2 border-accent-muted pl-2.5 text-[12.5px] leading-[1.5] text-fg-dim">
                  {selectedTagMission}
                  <div className="mt-1 font-mono text-[11px] text-fg-faint">
                    {selectedAgent?.model && selectedAgent.model !== 'inherit' ? selectedAgent.model : 'sonnet'}
                    {selectedAgent ? ` · ${selectedAgent.tools.join(' ') || 'no tool restriction'}` : ''}
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
              placeholder="Session title"
              className="mb-2 w-full appearance-none rounded-[10px] border border-line bg-bg px-[13px] py-[11px] text-sm font-semibold text-fg outline-none"
            />
            <textarea
              data-testid="new-epic-goal"
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onPaste={(e) => attachPastedFiles(e, att)}
              placeholder="The objective, in a sentence or two — this is sent as the first instruction. ⌘V to attach a screenshot."
              className="mb-3 w-full resize-y appearance-none rounded-[10px] border border-line bg-bg px-[13px] py-[11px] text-[13px] leading-[1.55] text-fg outline-none"
            />

            {/* References — one compact line, not the old full-width dashed
                drop zone. ⌘V is handled by the title/objective inputs and drop
                by this card's own container, so the only control that needs a
                place on screen is the small attach button. */}
            <div className="flex items-center gap-2">
              <AttachButton
                att={att}
                testId="new-epic-attach"
                size={14}
                className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md border border-line bg-bg text-fg-dim hover:bg-bg-elev hover:text-fg"
              />
              <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.09em] text-fg-faint">
                references{att.items.length ? ` · ${att.items.length}` : ''}
              </span>
            </div>
            <AttachTray att={att} testId="new-epic-attach-tray" />
            </div>

            <div className="mt-3 flex flex-shrink-0 items-center gap-2.5 border-t border-rule pt-3">
              <button
                type="button"
                data-testid="new-epic-flip-to-grounding"
                onClick={() => setAdvanced(true)}
                title="See what this session will actually load"
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
                  {creating ? 'Starting…' : 'Start Session'}
                </button>
              </span>
            </div>
          </div>

          {/* back */}
          <div
            className="absolute inset-0 flex flex-col rounded-2xl border border-line bg-bg-hi px-[26px] pt-6 pb-[18px]"
            style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
          >
            <NewEpicHeader eyebrow="New session · grounding" advanced={advanced} setAdvanced={setAdvanced} />
            <h2 className="m-0 font-serif text-2xl font-semibold tracking-[-0.3px] text-fg">
              What this session will know
            </h2>
            <p className="my-2 mb-[18px] text-[13.5px] leading-[1.55] text-fg-dim">
              Every layer of context this Epic's session actually loads before your goal is sent —
              real files this app can read, never a guess. Read-only: session-manager has no way to
              tell the claude CLI to skip one of these once it's on disk.
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">

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
              <div className="mt-1 text-sm font-semibold text-fg">{title || 'Untitled session'}</div>
              <div className="mt-0.5 text-[12.5px] leading-[1.5] text-fg-dim">{goal || selectedTagMission}</div>
              {/* Agent has no effect on /develop today — only the Mission tag does
                  (tagLibrary.ts's developEagerness/developsVia). Stated here,
                  explicitly, so it's obvious at Epic-creation time rather than only
                  discoverable in the separate Tag Library nav tab. */}
              <div className="mt-1.5 border-t border-rule pt-1.5 font-mono text-[11px] text-fg-faint">
                /develop: <span className="text-fg-dim">{tagLibraryEntry(tag).developsVia}</span>
                {' · '}
                {tagLibraryEntry(tag).developEagerness}
              </div>
            </div>

            {/* Context Injections — Session-Manager-authored text, independent
                of Actor/Input/Mission and independently toggleable (unlike the
                real-file inventory below, which is read-only by design). */}
            <div className="mb-3 rounded-[10px] border border-line bg-bg px-3 py-2.5">
              <div className="mb-1.5 text-[12.5px] font-semibold text-fg">Context injections</div>
              {CONTEXT_INJECTION_ORDER.map((key) => {
                const def = CONTEXT_INJECTIONS[key]
                const on = contextInjectionsOn[key]
                return (
                  <label key={key} className="flex cursor-pointer items-start gap-2 py-1">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => setInjectionOverrides((prev) => ({ ...prev, [key]: e.target.checked }))}
                      data-testid={`context-injection-toggle-${key}`}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="text-[12.5px] font-medium text-fg">{def.label}</span>
                      <span className="block text-[11.5px] leading-[1.4] text-fg-faint">{def.description}</span>
                    </span>
                  </label>
                )
              })}
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
            </div>

            <div className="mt-3 flex flex-shrink-0 items-center gap-2.5 border-t border-rule pt-3">
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
                  {creating ? 'Starting…' : 'Start Session'}
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
