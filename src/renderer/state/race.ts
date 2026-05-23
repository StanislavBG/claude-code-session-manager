import { create } from 'zustand'
import type { TranscriptEvent } from '../../preload/api'

/**
 * Race feature — pick N existing tabs, send the same prompt to all of them,
 * watch their transcripts side-by-side, declare a winner.
 *
 * MVP scope (matches CLAUDE.md "extend, don't add tabs" — this lives behind a
 * modal): user picks 2..N already-running tabs. Spawning ephemeral tabs from
 * presets is a v2 feature.
 *
 * State flow:
 *   idle   → user opens modal, selects tabs, types prompt
 *   running → modal sent the prompt to each tab, transcript listeners are wired
 *             per participant; each participant transitions to 'done' on the
 *             first assistant message that arrives AFTER race start time
 *   finished → user declared a winner (or every participant finished)
 *
 * Renderer-only: no main IPC needed beyond pty.write + transcripts.onEvent
 * which we already expose.
 */

export type RaceStatus = 'idle' | 'running' | 'finished'
export type ParticipantStatus = 'waiting' | 'running' | 'done'

export interface RaceParticipant {
  /** Existing session tab id; race writes the prompt into this tab's PTY. */
  tabId: string
  /** Cached label for display (tab labels can change while race runs). */
  label: string
  /** Cached preset id for display. */
  presetId: string | null
  status: ParticipantStatus
  /** Most recent transcript snippets (newest at tail), capped at 8. */
  outputDigest: string[]
  /** ms timestamp of the first assistant message after race start. */
  doneAt: number | null
}

export interface RaceHistoryEntry {
  startedAt: number
  prompt: string
  participants: { tabId: string; label: string; presetId: string | null; status: ParticipantStatus; doneAt: number | null }[]
  winnerTabId: string | null
}

interface RaceState {
  status: RaceStatus
  prompt: string
  startedAt: number | null
  participants: RaceParticipant[]
  winnerTabId: string | null
  /** Per-tab unsubscribe handles from transcripts.onEvent. */
  _unsubs: Record<string, () => void>

  /** Reset + seed participants. Doesn't write to any PTY yet. */
  configure: (prompt: string, picks: { tabId: string; label: string; presetId: string | null }[]) => void
  /** Wire transcript listeners, mark startedAt, transition each to 'running'. */
  begin: () => void
  /** Caller hands us a transcript event for a specific tab so we can grade it. */
  ingest: (tabId: string, ev: TranscriptEvent) => void
  /** User clicks "Declare winner" on a panel. Saves to localStorage history. */
  declareWinner: (tabId: string) => void
  /** Hard reset — clears participants, unsubscribes listeners. */
  reset: () => void
}

const HISTORY_KEY = 'sm.race.history'
const HISTORY_CAP = 20
const DIGEST_CAP = 8
const DIGEST_LINE_MAX = 200

/** Read recent races from localStorage. Safe against parse failures. */
export function readRaceHistory(): RaceHistoryEntry[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(HISTORY_KEY) : null
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as RaceHistoryEntry[]) : []
  } catch {
    return []
  }
}

function writeRaceHistory(entries: RaceHistoryEntry[]): void {
  try {
    if (typeof localStorage === 'undefined') return
    const trimmed = entries.slice(0, HISTORY_CAP)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed))
  } catch {
    // Quota / privacy mode — silently drop. Race itself still works.
  }
}

/** Pull a readable snippet out of a transcript event for the panel preview. */
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
    // The assistant message body lives in raw.message.content (array of blocks).
    // Extract the first text block as a readable snippet.
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

/**
 * "Done" detector: an assistant message that arrives AFTER race startedAt.
 * Claude Code emits one final assistant message per turn after all tool calls
 * finish, so this matches the natural end-of-turn boundary.
 */
function isDoneSignal(ev: TranscriptEvent): boolean {
  return ev.kind === 'assistant'
}

export const useRace = create<RaceState>((set, get) => ({
  status: 'idle',
  prompt: '',
  startedAt: null,
  participants: [],
  winnerTabId: null,
  _unsubs: {},

  configure: (prompt, picks) => {
    // Tear down any prior listeners first.
    for (const off of Object.values(get()._unsubs)) {
      try { off() } catch { /* listener already detached */ }
    }
    const participants: RaceParticipant[] = picks.map((p) => ({
      tabId: p.tabId,
      label: p.label,
      presetId: p.presetId,
      status: 'waiting',
      outputDigest: [],
      doneAt: null,
    }))
    set({
      status: 'idle',
      prompt,
      startedAt: null,
      participants,
      winnerTabId: null,
      _unsubs: {},
    })
  },

  begin: () => {
    const state = get()
    if (state.participants.length === 0) return
    const startedAt = Date.now()
    const unsubs: Record<string, () => void> = {}
    // Wire one transcript listener per participant. The live store may already
    // be subscribed for these tabs (Header indicators, AgentView) — that's
    // fine, onEvent is multi-subscriber by design.
    for (const p of state.participants) {
      const off = window.api.transcripts.onEvent(p.tabId, (ev) => {
        get().ingest(p.tabId, ev)
      })
      unsubs[p.tabId] = off
    }
    set({
      status: 'running',
      startedAt,
      participants: state.participants.map((p) => ({ ...p, status: 'running' as const })),
      _unsubs: unsubs,
    })
  },

  ingest: (tabId, ev) => {
    const state = get()
    if (state.status !== 'running') return
    const idx = state.participants.findIndex((p) => p.tabId === tabId)
    if (idx === -1) return
    const cur = state.participants[idx]
    const next = { ...cur }

    const snippet = digestFor(ev)
    if (snippet) {
      // Append + cap. O(1) effective: array slice over a small constant.
      next.outputDigest = [...cur.outputDigest, snippet].slice(-DIGEST_CAP)
    }

    if (cur.status === 'running' && isDoneSignal(ev)) {
      next.status = 'done'
      next.doneAt = Date.now()
    }

    if (next === cur) return
    const participants = state.participants.slice()
    participants[idx] = next
    set({ participants })
  },

  declareWinner: (tabId) => {
    const state = get()
    if (!state.participants.some((p) => p.tabId === tabId)) return
    // Detach listeners — race is over.
    for (const off of Object.values(state._unsubs)) {
      try { off() } catch { /* already detached */ }
    }
    const entry: RaceHistoryEntry = {
      startedAt: state.startedAt ?? Date.now(),
      prompt: state.prompt,
      participants: state.participants.map((p) => ({
        tabId: p.tabId,
        label: p.label,
        presetId: p.presetId,
        status: p.status,
        doneAt: p.doneAt,
      })),
      winnerTabId: tabId,
    }
    const history = readRaceHistory()
    writeRaceHistory([entry, ...history])
    set({ status: 'finished', winnerTabId: tabId, _unsubs: {} })
  },

  reset: () => {
    for (const off of Object.values(get()._unsubs)) {
      try { off() } catch { /* */ }
    }
    set({
      status: 'idle',
      prompt: '',
      startedAt: null,
      participants: [],
      winnerTabId: null,
      _unsubs: {},
    })
  },
}))
