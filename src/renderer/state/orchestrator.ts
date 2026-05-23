import { create } from 'zustand'
import type { TranscriptEvent } from '../../preload/api'

/**
 * Orchestrator — port of ClaudeCodeUnleashed's Orchestrator feature, slimmed
 * for the session-manager MVP.
 *
 * Concept: user picks N existing tabs, assigns each a sub-task that decomposes
 * a parent goal ("plan"). Each tab gets its specific prompt written to its PTY.
 * A grid view shows the latest few transcript lines per tab, plus a status
 * pill. Orchestrator-wide controls: pause (UI-only halt of the watch),
 * resume, nudgeAll (broadcasts "are you stuck?" to every tab), stop (tear
 * down listeners, mark idle).
 *
 * Differences vs. Unleashed:
 *   - Renderer-only. No coordinator LLM, no decomposition API, no safety
 *     levels. The user types each sub-task themselves (MVP). Decomposition
 *     can ship in v2.
 *   - Pause is *not* a PTY-level pause. Claude in each terminal keeps
 *     working. We just stop ingesting transcript events into the digest so
 *     the grid stops scrolling — same semantic as Unleashed's `isPaused`
 *     coordinator flag, but without the LLM-driven nudges.
 *   - Requires existing tabs (matches Race MVP). Spawning new tabs from a
 *     preset is v2 — needs the spawn→ready handshake.
 *
 * State flow:
 *   idle → user configures plan + per-tab tasks
 *   running → modal sent each prompt to its tab, listeners wired
 *   paused → listeners detached, status preserved; resume() re-wires
 *   stopped → final state, requires reset() to start over
 *
 * Renderer-only — same plumbing as Race (`pty.write` + `transcripts.onEvent`).
 */

export type OrchestratorStatus = 'idle' | 'running' | 'paused' | 'stopped'
export type TaskStatus = 'pending' | 'sent' | 'working' | 'done'

export interface OrchestratorTask {
  /** Existing session tab id; orchestrator writes the sub-task into this PTY. */
  tabId: string
  /** Cached label for display. */
  label: string
  /** Cached preset id for display. */
  presetId: string | null
  /** The sub-task prompt the user wrote for this tab. */
  prompt: string
  status: TaskStatus
  /** Most recent transcript snippets (newest at tail), capped. */
  outputDigest: string[]
  /** ms timestamp of the first assistant message after task sent. */
  doneAt: number | null
}

interface OrchestratorState {
  status: OrchestratorStatus
  /** The parent goal the user is fanning out to the team. */
  plan: string
  startedAt: number | null
  tasks: OrchestratorTask[]
  /** When a Hive launches, it seeds this with one entry per role. The
   *  Orchestrator modal reads it on open, copies the prompts into its local
   *  row form (each role becomes one row, tabId empty until the user picks),
   *  and then clears this. Acts as a one-shot mailbox between
   *  HiveManagerModal and OrchestratorModal. */
  pendingRoles: { label: string; prompt: string }[]
  /** Per-tab unsubscribe handles from transcripts.onEvent. */
  _unsubs: Record<string, () => void>

  /** Seed tasks. Tear down any prior listeners. */
  configure: (plan: string, picks: { tabId: string; label: string; presetId: string | null; prompt: string }[]) => void
  /** Write each task's prompt to its tab, wire listeners, transition to running. */
  start: () => void
  /** Detach listeners; tasks keep their status. Tabs keep working in their PTYs. */
  pause: () => void
  /** Re-wire listeners. */
  resume: () => void
  /** Send a "are you stuck?" prompt to every task tab. */
  nudgeAll: () => void
  /** Caller hands us a transcript event for a specific tab so we can grade it. */
  ingest: (tabId: string, ev: TranscriptEvent) => void
  /** Mark stopped — detach listeners. */
  stop: () => void
  /** Hard reset back to idle. */
  reset: () => void
  /** Pre-fill the orchestrator with a Hive's roles. Does NOT bind tabs (the
   *  user still has to pick which tab gets each role in the modal) and does
   *  NOT start the run. Each role becomes a row with an empty `tabId` until
   *  the user assigns one. The orchestrator modal must filter these out or
   *  treat them as "needs tab" placeholders before calling start().
   *
   *  This is the bridge HiveManagerModal calls when the user hits Launch. The
   *  hive's defaultPlan (if any) seeds the plan box; otherwise it stays empty
   *  and the user types one. */
  launchHive: (hive: { name: string; defaultPlan?: string; roles: { label: string; prompt: string }[] }) => void
}

const DIGEST_CAP = 5
const DIGEST_LINE_MAX = 200
const NUDGE_PROMPT = 'Are you stuck? Briefly summarize what you are blocked on, or continue with the next step.'

/** Pull a readable snippet out of a transcript event for the grid preview. */
function digestFor(ev: TranscriptEvent): string | null {
  if (ev.kind === 'tool_use') {
    const d = ev.data as { name?: string; input?: unknown } | null
    if (!d?.name) return null
    const input = d.input as Record<string, unknown> | null | undefined
    const filePath = typeof input?.file_path === 'string' ? input.file_path : undefined
    const command = typeof input?.command === 'string' ? input.command : undefined
    const detail = filePath ? filePath.split('/').pop() ?? filePath : command ?? ''
    return detail ? `${d.name} · ${detail}` : d.name
  }
  if (ev.kind === 'todo_write') {
    const arr = Array.isArray(ev.data) ? (ev.data as { content?: string }[]) : []
    return `Todos · ${arr.length} item${arr.length !== 1 ? 's' : ''}`
  }
  if (ev.kind === 'plan') {
    return 'Plan revised'
  }
  if (ev.kind === 'agent_spawn') {
    const d = ev.data as { subagent_type?: string } | null
    return d?.subagent_type ? `Agent: ${d.subagent_type}` : 'Agent spawned'
  }
  if (ev.kind === 'assistant') {
    const raw = ev.raw as { message?: { content?: unknown } } | null
    const content = raw?.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const text = (block as { text?: string }).text
          if (typeof text === 'string') return text.slice(0, DIGEST_LINE_MAX)
        }
      }
    }
    return 'assistant: (response)'
  }
  return null
}

/** "Done" detector: an assistant message arriving after a task is in flight. */
function isDoneSignal(ev: TranscriptEvent): boolean {
  return ev.kind === 'assistant'
}

function wireListener(tabId: string): () => void {
  return window.api.transcripts.onEvent(tabId, (ev) => {
    useOrchestrator.getState().ingest(tabId, ev)
  })
}

function tearDownListeners(unsubs: Record<string, () => void>): void {
  for (const off of Object.values(unsubs)) {
    try { off() } catch { /* already detached */ }
  }
}

export const useOrchestrator = create<OrchestratorState>((set, get) => ({
  status: 'idle',
  plan: '',
  startedAt: null,
  tasks: [],
  pendingRoles: [],
  _unsubs: {},

  configure: (plan, picks) => {
    tearDownListeners(get()._unsubs)
    const tasks: OrchestratorTask[] = picks.map((p) => ({
      tabId: p.tabId,
      label: p.label,
      presetId: p.presetId,
      prompt: p.prompt,
      status: 'pending',
      outputDigest: [],
      doneAt: null,
    }))
    set({
      status: 'idle',
      plan,
      startedAt: null,
      tasks,
      pendingRoles: [],
      _unsubs: {},
    })
  },

  start: () => {
    const state = get()
    if (state.tasks.length === 0) return
    const startedAt = Date.now()
    const unsubs: Record<string, () => void> = {}

    // Send each task's prompt to its tab. `\r` is the PTY line terminator
    // (same convention as BroadcastBar and RaceModal). If a tab fails to
    // receive (e.g. its PTY exited), we still wire the listener and let the
    // UI show 'pending' — the user can stop or retry.
    for (const t of state.tasks) {
      try {
        window.api.pty.write({ tabId: t.tabId, data: t.prompt + '\r' })
      } catch (e) {
        console.warn('[orchestrator] pty.write failed for', t.tabId, e)
      }
      unsubs[t.tabId] = wireListener(t.tabId)
    }

    set({
      status: 'running',
      startedAt,
      tasks: state.tasks.map((t) => ({ ...t, status: 'sent' as const })),
      _unsubs: unsubs,
    })
  },

  pause: () => {
    const state = get()
    if (state.status !== 'running') return
    tearDownListeners(state._unsubs)
    set({ status: 'paused', _unsubs: {} })
  },

  resume: () => {
    const state = get()
    if (state.status !== 'paused') return
    const unsubs: Record<string, () => void> = {}
    for (const t of state.tasks) {
      unsubs[t.tabId] = wireListener(t.tabId)
    }
    set({ status: 'running', _unsubs: unsubs })
  },

  nudgeAll: () => {
    const state = get()
    if (state.tasks.length === 0) return
    for (const t of state.tasks) {
      try {
        window.api.pty.write({ tabId: t.tabId, data: NUDGE_PROMPT + '\r' })
      } catch (e) {
        console.warn('[orchestrator] nudge write failed for', t.tabId, e)
      }
    }
  },

  ingest: (tabId, ev) => {
    const state = get()
    if (state.status !== 'running') return
    const idx = state.tasks.findIndex((t) => t.tabId === tabId)
    if (idx === -1) return
    const cur = state.tasks[idx]
    const next = { ...cur }

    const snippet = digestFor(ev)
    if (snippet) {
      next.outputDigest = [...cur.outputDigest, snippet].slice(-DIGEST_CAP)
    }

    // First non-pending event => promote to 'working'.
    if (cur.status === 'sent') {
      next.status = 'working'
    }

    if ((cur.status === 'sent' || cur.status === 'working') && isDoneSignal(ev)) {
      next.status = 'done'
      next.doneAt = Date.now()
    }

    if (next === cur) return
    const tasks = state.tasks.slice()
    tasks[idx] = next
    set({ tasks })
  },

  stop: () => {
    tearDownListeners(get()._unsubs)
    set({ status: 'stopped', _unsubs: {} })
  },

  reset: () => {
    tearDownListeners(get()._unsubs)
    set({
      status: 'idle',
      plan: '',
      startedAt: null,
      tasks: [],
      pendingRoles: [],
      _unsubs: {},
    })
  },

  launchHive: (hive) => {
    // Hard reset any prior run before seeding new roles.
    tearDownListeners(get()._unsubs)
    set({
      status: 'idle',
      plan: hive.defaultPlan?.trim() || `Launch hive: ${hive.name}`,
      startedAt: null,
      tasks: [],
      pendingRoles: hive.roles.map((r) => ({ label: r.label, prompt: r.prompt })),
      _unsubs: {},
    })
  },
}))
