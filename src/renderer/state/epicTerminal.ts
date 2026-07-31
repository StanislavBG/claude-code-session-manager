import { create } from 'zustand'

/**
 * Chat <-> Terminal mode + attachment tracking for Epics (PRD 831). An Epic
 * IS a tagged claude session (claudeSessionId 1:1) — Chat (headless
 * chatRunner) and Terminal (in-pane PTY) are two mutually-exclusive VIEWS
 * over that one session, never two concurrent attachments. Island store,
 * keyed by epicId (PromptSession.id): `attached` is read by chat.ts's
 * send() to refuse a chat send while a live Terminal PTY holds the session,
 * without chat.ts needing to know anything about EpicTerminalPane/xterm.
 */

export type EpicTerminalMode = 'chat' | 'terminal'

interface EpicTerminalState {
  modes: Record<string, EpicTerminalMode>
  attached: Record<string, boolean>
  setMode: (epicId: string, mode: EpicTerminalMode) => void
  setAttached: (epicId: string, attached: boolean) => void
  isAttached: (epicId: string) => boolean
}

export const useEpicTerminal = create<EpicTerminalState>((set, get) => ({
  modes: {},
  attached: {},
  setMode: (epicId, mode) => set((s) => ({ modes: { ...s.modes, [epicId]: mode } })),
  setAttached: (epicId, attached) => set((s) => ({ attached: { ...s.attached, [epicId]: attached } })),
  isAttached: (epicId) => Boolean(get().attached[epicId]),
}))
