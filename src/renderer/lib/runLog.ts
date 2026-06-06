/**
 * Pure parser for scheduler job run logs.
 *
 * Logs are the stdout of `claude -p --output-format stream-json` runs:
 * newline-delimited JSON objects ({"type":"assistant"|"user"|"result"|"system",...})
 * possibly interleaved with non-JSON lines. Never throws on malformed input.
 */

export interface ParsedEvent {
  /** Event type from the JSON, or "raw" for non-JSON lines. */
  type: string
  /** Full raw line. */
  raw: string
  /** One-line preview (≤200 chars). */
  preview: string
  isError: boolean
}

export interface ErrorSummary {
  count: number
  firstMessage: string | null
}

export interface ParsedRunLog {
  /** Parsed events (first MAX_EVENTS non-empty lines). */
  events: ParsedEvent[]
  errors: ErrorSummary
  /** Total non-empty line count in the raw text. */
  rawLineCount: number
  /** True when rawLineCount > MAX_EVENTS and the returned events are capped. */
  truncated: boolean
}

const MAX_EVENTS = 2000

function isErrorEvent(parsed: Record<string, unknown>): boolean {
  if (parsed.is_error === true) return true
  if (parsed.error != null && parsed.error !== '') return true
  if (parsed.type === 'result' && parsed.subtype !== 'success' && parsed.subtype != null) return true
  return false
}

function extractErrorMessage(parsed: Record<string, unknown>): string {
  if (typeof parsed.error === 'string' && parsed.error) return parsed.error
  if (typeof parsed.result === 'string' && parsed.result) return parsed.result
  if (typeof parsed.subtype === 'string') return parsed.subtype
  return JSON.stringify(parsed).slice(0, 200)
}

function extractPreview(parsed: Record<string, unknown>): string {
  // Top-level text field
  if (typeof parsed.text === 'string') return parsed.text.slice(0, 200)
  // content block (string or array of blocks)
  if (typeof parsed.content === 'string') return parsed.content.slice(0, 200)
  if (Array.isArray(parsed.content)) {
    for (const block of parsed.content) {
      if (block && typeof block === 'object' && 'text' in block && typeof (block as Record<string, unknown>).text === 'string') {
        return ((block as Record<string, unknown>).text as string).slice(0, 200)
      }
    }
  }
  // Nested message text (assistant/user message events)
  const msg = parsed.message
  if (msg && typeof msg === 'object') {
    const m = msg as Record<string, unknown>
    if (typeof m.content === 'string') return m.content.slice(0, 200)
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object' && 'text' in block && typeof (block as Record<string, unknown>).text === 'string') {
          return ((block as Record<string, unknown>).text as string).slice(0, 200)
        }
      }
    }
  }
  // result events
  if (typeof parsed.result === 'string' && parsed.result) return parsed.result.slice(0, 200)
  if (typeof parsed.subtype === 'string') return parsed.subtype
  return JSON.stringify(parsed).slice(0, 200)
}

export function parseRunLog(text: string): ParsedRunLog {
  if (!text || !text.trim()) {
    return { events: [], errors: { count: 0, firstMessage: null }, rawLineCount: 0, truncated: false }
  }

  const allLines = text.split('\n')
  const nonEmpty = allLines.filter((l) => l.trim().length > 0)
  const rawLineCount = nonEmpty.length
  const truncated = rawLineCount > MAX_EVENTS
  const linesToProcess = truncated ? nonEmpty.slice(0, MAX_EVENTS) : nonEmpty

  const events: ParsedEvent[] = []
  let errorCount = 0
  let firstErrorMessage: string | null = null

  for (const rawLine of linesToProcess) {
    let parsed: Record<string, unknown> | null = null
    try {
      const obj = JSON.parse(rawLine)
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj) && 'type' in obj) {
        parsed = obj as Record<string, unknown>
      }
    } catch {
      // non-JSON or malformed — treat as raw line
    }

    if (parsed !== null) {
      const type = typeof parsed.type === 'string' ? parsed.type : 'unknown'
      const isError = isErrorEvent(parsed)
      if (isError) {
        errorCount++
        if (firstErrorMessage === null) firstErrorMessage = extractErrorMessage(parsed)
      }
      events.push({ type, raw: rawLine, preview: extractPreview(parsed), isError })
    } else {
      events.push({ type: 'raw', raw: rawLine, preview: rawLine.slice(0, 200), isError: false })
    }
  }

  return { events, errors: { count: errorCount, firstMessage: firstErrorMessage }, rawLineCount, truncated }
}
