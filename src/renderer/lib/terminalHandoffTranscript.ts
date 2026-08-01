/**
 * Real-turn extraction for the Terminal→Chat handoff (PRD 863). When a user
 * finishes iterating in Terminal mode and switches an Epic back to Chat,
 * EpicDetail.tsx's returnToChat() used to record only a hardcoded
 * `'Iterated in Terminal view'` placeholder — this module parses the actual
 * session JSONL (the same file transcripts.cjs tails) into user/assistant
 * turns so the real conversation can be captured to the durable transcript
 * store instead. The placeholder stays as the fallback for when parsing
 * yields nothing (empty/missing file, no text-bearing turns).
 */

export interface HandoffTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

interface ContentBlock {
  type?: string
  text?: string
}

/** One line of a claude-code session JSONL — only the fields this module reads. */
interface TranscriptLine {
  type?: string
  timestamp?: string
  message?: {
    role?: string
    content?: string | ContentBlock[]
  }
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim()
}

/**
 * Parses raw session JSONL text into an ordered list of user/assistant turns
 * that carry real text. Tool-only turns (no text block) are dropped rather
 * than emitted empty. Skips unparseable/torn lines instead of throwing — a
 * single corrupt line must never blank the whole handoff.
 */
export function parseTranscriptTurns(rawJsonl: string): HandoffTurn[] {
  const turns: HandoffTurn[] = []
  for (const line of rawJsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: TranscriptLine
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    const role = obj.type === 'user' || obj.type === 'assistant' ? obj.type : obj.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = extractText(obj.message?.content)
    if (!text) continue
    turns.push({ role, text, at: obj.timestamp || new Date().toISOString() })
  }
  return turns
}

/**
 * Filters to only the turns not already captured by the durable store,
 * so re-toggling Terminal↔Chat on the same Epic doesn't re-append turns a
 * prior handoff already persisted. `lastCapturedAt` is the `at` of the most
 * recent durable turn (or null if none yet) — every parsed turn strictly
 * after it is new.
 */
export function selectNewTurns(turns: HandoffTurn[], lastCapturedAt: string | null): HandoffTurn[] {
  if (!lastCapturedAt) return turns
  const cutoff = Date.parse(lastCapturedAt)
  if (Number.isNaN(cutoff)) return turns
  return turns.filter((t) => {
    const ts = Date.parse(t.at)
    return Number.isNaN(ts) || ts > cutoff
  })
}
