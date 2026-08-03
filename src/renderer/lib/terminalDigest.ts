// Builds a plain-text digest of prior conversation turns from the same
// classified transcript events live.ts replays into the AgentView store, so
// a reloaded Terminal.tsx can show history instead of an empty scrollback
// (the pty reattach/respawn in pty.cjs never replays prior PTY bytes).

import type { TranscriptEvent } from '../../preload/api'

const DIM = '\x1b[38;5;240m'
const RESET = '\x1b[0m'

// Transcript text is replayed verbatim into xterm's live buffer, so strip any
// embedded escape sequences (CSI/OSC/ESC) before writing — otherwise stored
// conversation text (which may itself contain control bytes, e.g. pasted
// terminal output) could manipulate cursor position, the window title, or
// trigger OSC 52 clipboard writes when replayed here.
// eslint-disable-next-line no-control-regex
const CONTROL_SEQ_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g
function stripAnsi(text: string): string {
  return text.replace(CONTROL_SEQ_RE, '')
}

// classifyLine (main-process) now emits one event per content block instead
// of one event per line. A text block's kind is the message's own role
// ('user'/'assistant') and its data is the block's plain text string — no
// need to re-parse a whole-line object shape here.
function roleForKind(kind: string): 'You' | 'Claude' | null {
  if (kind === 'user') return 'You'
  if (kind === 'assistant') return 'Claude'
  return null
}

function extractText(ev: TranscriptEvent): string | null {
  const role = roleForKind(ev.kind)
  if (!role || typeof ev.data !== 'string') return null
  const text = stripAnsi(ev.data).trim()
  if (!text) return null
  return `${DIM}[${role}] ${text}${RESET}\r\n`
}

/** Returns a dim-styled digest of prior message turns, or null when there's nothing to show. */
export function buildTranscriptDigest(events: TranscriptEvent[]): string | null {
  const lines = events
    .map((ev) => extractText(ev))
    .filter((line): line is string => line !== null)
  if (lines.length === 0) return null
  return (
    `${DIM}── prior conversation (from transcript) ──${RESET}\r\n` +
    lines.join('') +
    `${DIM}── end prior conversation ──${RESET}\r\n`
  )
}

interface FetchDigestArgs {
  tabId: string
  cwd: string
}

/**
 * Best-effort fetch: never throws, resolves null on any failure or empty history.
 * Does not unsubscribe afterward — live.ts owns this tabId's subscription
 * lifecycle (subscribe() in transcripts.cjs is idempotent, so this call just
 * ensures a subscription exists without racing or double-releasing it).
 */
export async function fetchTerminalDigest({ tabId, cwd }: FetchDigestArgs): Promise<string | null> {
  try {
    const sub = await window.api.transcripts.subscribe({ tabId, cwd, sessionUuid: tabId })
    if (!sub.ok) return null
    const events = await window.api.transcripts.buffer(tabId)
    return buildTranscriptDigest(events)
  } catch {
    return null
  }
}
