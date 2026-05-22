import { create } from 'zustand'
import type { TranscriptEvent } from '../../preload/api'

/**
 * Per-tab live state derived from the session transcript JSONL. Consumers
 * (Tasks, Subagents, Plans, Usage tabs) read slices of this.
 *
 * One subscription per tab; ref-counted so multiple components can observe
 * without double-subscribing.
 */

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface ToolUseEntry {
  id?: string
  name: string
  input: unknown
  at: number
}

export interface PlanEntry {
  at: number
  content: string
}

export interface AgentSpawnEntry {
  /** toolUseId from the spawning Task/Agent tool_use block; used to match tool_result events. */
  id?: string
  at: number
  subagentType?: string
  description?: string
  /**
   * Updated when the Task tool_use begins (spawn) and again when its tool_result
   * returns (completion). Claude Code's JSONL does not carry per-sub-event agent
   * attribution — subagent activity only appears in the parent stream at these two
   * bookend points. Finer granularity requires following the subagent's own
   * transcript file (out of scope).
   */
  lastActivityAt: number
}

export interface UsageSnapshot {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}

export type ActivityKind =
  | 'tool-use'
  | 'todo-update'
  | 'plan-revision'
  | 'agent-spawn'
  | 'file-edit'
  | 'usage-tick'

export interface ActivityEvent {
  id: number          // monotonic, from activitySeq
  kind: ActivityKind
  at: number
  label: string       // short human-readable, max ~40 chars
  target?: string     // file path for edits, command for bash
  toolName?: string
}

export interface LiveTab {
  tabId: string
  sessionUuid: string
  cwd: string
  path: string | null
  todos: TodoItem[]
  lastToolUses: ToolUseEntry[]
  plans: PlanEntry[]
  agents: AgentSpawnEntry[]
  usage: UsageSnapshot
  /** ms timestamp of the last transcript event — used by AgentView to decide idle vs working. */
  lastEventAt: number
  activityRing: ActivityEvent[]   // bounded to 32 entries, newest at tail
  activitySeq: number             // monotonic id source
}

interface LiveState {
  tabs: Record<string, LiveTab>
  refs: Record<string, number>
  unsubs: Record<string, () => void>

  subscribe: (tabId: string, cwd: string, sessionUuid: string) => void
  unsubscribe: (tabId: string) => void
  ingest: (tabId: string, ev: TranscriptEvent, opts?: { replay?: boolean }) => void
}

function touchAgent(agents: AgentSpawnEntry[], agentId: string | undefined, ts: number): AgentSpawnEntry[] {
  if (!agentId) return agents
  return agents.map((a) => a.id === agentId ? { ...a, lastActivityAt: ts } : a)
}

function blankTab(tabId: string, cwd: string, sessionUuid: string): LiveTab {
  return {
    tabId,
    sessionUuid,
    cwd,
    path: null,
    todos: [],
    lastToolUses: [],
    plans: [],
    agents: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    lastEventAt: 0,
    activityRing: [],
    activitySeq: 0,
  }
}

export const useLive = create<LiveState>((set, get) => ({
  tabs: {},
  refs: {},
  unsubs: {},

  subscribe: (tabId, cwd, sessionUuid) => {
    const refs = { ...get().refs }
    refs[tabId] = (refs[tabId] ?? 0) + 1
    set({ refs })
    if (refs[tabId] > 1) return
    // First subscriber — create the live tab entry + wire up IPC.
    set({
      tabs: { ...get().tabs, [tabId]: blankTab(tabId, cwd, sessionUuid) },
    })
    // Attach onEvent listener BEFORE invoking subscribe so no live append is
    // missed between subscribe returning and the listener being registered.
    const off = window.api.transcripts.onEvent(tabId, (ev) => get().ingest(tabId, ev))
    set({ unsubs: { ...get().unsubs, [tabId]: off } })
    // Await subscribe so the main process has populated sub.buffer + inserted
    // into its Map, then drain the buffer for replay. Chaining (not parallel)
    // is required — buffer() would race and return [] otherwise.
    window.api.transcripts
      .subscribe({ tabId, cwd, sessionUuid })
      .then(async (r) => {
        const cur = get().tabs[tabId]
        if (!cur) return
        set({ tabs: { ...get().tabs, [tabId]: { ...cur, path: r.path } } })
        const events = await window.api.transcripts.buffer(tabId)
        // Replay of historical events — don't bump lastEventAt, otherwise
        // AgentView would flash 'working' on every mount while the buffer drains.
        for (const ev of events) get().ingest(tabId, ev, { replay: true })
      })
      .catch((e) => console.error('[live] transcripts.subscribe failed:', tabId, e))
  },

  unsubscribe: (tabId) => {
    const refs = { ...get().refs }
    if (!refs[tabId]) return
    refs[tabId]--
    if (refs[tabId] > 0) {
      set({ refs })
      return
    }
    delete refs[tabId]
    const off = get().unsubs[tabId]
    off?.()
    const unsubs = { ...get().unsubs }
    delete unsubs[tabId]
    const tabs = { ...get().tabs }
    delete tabs[tabId]
    window.api.transcripts.unsubscribe(tabId)
    set({ refs, unsubs, tabs })
  },

  ingest: (tabId, ev, opts) => {
    const cur = get().tabs[tabId]
    if (!cur) return
    const now = Date.now()
    const next: LiveTab = { ...cur, lastEventAt: opts?.replay ? cur.lastEventAt : now }
    const newActivity: ActivityEvent[] = []

    // Helper to truncate a string to max chars
    const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s

    switch (ev.kind) {
      case 'todo_write': {
        const todos = Array.isArray(ev.data) ? (ev.data as TodoItem[]) : []
        next.todos = todos
        if (!opts?.replay) {
          newActivity.push({
            id: 0,
            kind: 'todo-update',
            at: now,
            label: `Todos · ${todos.length} item${todos.length !== 1 ? 's' : ''}`,
          })
        }
        break
      }
      case 'tool_use': {
        const d = ev.data as { name: string; input: unknown; id?: string }
        next.lastToolUses = [
          { id: d.id, name: d.name, input: d.input, at: now },
          ...cur.lastToolUses,
        ].slice(0, 50)
        if (!opts?.replay) {
          const input = d.input as Record<string, unknown> | null | undefined
          const isFileOp = ['Edit', 'Write', 'NotebookEdit'].includes(d.name)
          const filePath = typeof input?.file_path === 'string' ? input.file_path : undefined
          const command = typeof input?.command === 'string' ? input.command : undefined
          const detail = filePath
            ? filePath.split('/').pop() ?? filePath
            : command
            ? trunc(command, 28)
            : ''
          newActivity.push({
            id: 0,
            kind: 'tool-use',
            at: now,
            label: detail ? `${d.name} · ${detail}` : d.name,
            target: filePath ?? command,
            toolName: d.name,
          })
          if (isFileOp && filePath) {
            newActivity.push({
              id: 0,
              kind: 'file-edit',
              at: now,
              label: `${d.name} · ${trunc(filePath.split('/').pop() ?? filePath, 34)}`,
              target: filePath,
              toolName: d.name,
            })
          }
        }
        break
      }
      case 'plan': {
        const input = ev.data as { plan?: string } | string | undefined
        const text = typeof input === 'string' ? input : input?.plan ?? JSON.stringify(input)
        // Cap at 50 — the main-side ring buffer (500 events) bounds REPLAY
        // growth but every live `plan` event still appends here, so an
        // explicit slice is required to keep this array bounded across a
        // long-lived session.
        next.plans = [{ at: now, content: text ?? '' }, ...cur.plans].slice(0, 50)
        if (!opts?.replay) {
          newActivity.push({
            id: 0,
            kind: 'plan-revision',
            at: now,
            label: 'Plan revised',
          })
        }
        break
      }
      case 'agent_spawn': {
        const d = ev.data as { subagent_type?: string; description?: string; toolUseId?: string }
        next.agents = [
          { id: d?.toolUseId, at: now, subagentType: d?.subagent_type, description: d?.description, lastActivityAt: now },
          ...cur.agents,
        ].slice(0, 50)
        if (!opts?.replay) {
          newActivity.push({
            id: 0,
            kind: 'agent-spawn',
            at: now,
            label: d?.subagent_type ? `Agent: ${trunc(d.subagent_type, 32)}` : 'Agent spawned',
          })
        }
        break
      }
      case 'usage': {
        const u = ev.data as Partial<UsageSnapshot> & {
          input_tokens?: number
          output_tokens?: number
          cache_creation_input_tokens?: number
          cache_read_input_tokens?: number
        }
        const prevTotal = (cur.usage.inputTokens || 0) + (cur.usage.outputTokens || 0)
        const addedIn = u.input_tokens ?? u.inputTokens ?? 0
        const addedOut = u.output_tokens ?? u.outputTokens ?? 0
        const newTotal = prevTotal + addedIn + addedOut
        next.usage = {
          inputTokens: (cur.usage.inputTokens || 0) + addedIn,
          outputTokens: (cur.usage.outputTokens || 0) + addedOut,
          cacheCreationInputTokens:
            (cur.usage.cacheCreationInputTokens || 0) +
            (u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0),
          cacheReadInputTokens:
            (cur.usage.cacheReadInputTokens || 0) +
            (u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0),
        }
        if (!opts?.replay && Math.floor(newTotal / 1000) > Math.floor(prevTotal / 1000)) {
          newActivity.push({
            id: 0,
            kind: 'usage-tick',
            at: now,
            label: `${Math.floor(newTotal / 1000)}k tokens`,
          })
        }
        break
      }
      case 'tool_result': {
        if (!opts?.replay) {
          const d = ev.data as { toolUseId?: string }
          next.agents = touchAgent(cur.agents, d?.toolUseId, now)
        }
        break
      }
      default:
        // Plain message/user/assistant/system events have no derived field
        // to update, but they MUST still bump lastEventAt — otherwise
        // AgentView stays 'idle' the whole time the model is streaming text.
        break
    }

    // Assign monotonic IDs and push to ring buffer
    if (newActivity.length > 0) {
      let seq = cur.activitySeq
      const stamped = newActivity.map((a) => ({ ...a, id: ++seq }))
      next.activitySeq = seq
      next.activityRing = [...cur.activityRing, ...stamped].slice(-32)
    }

    set({ tabs: { ...get().tabs, [tabId]: next } })
  },
}))
