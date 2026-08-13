/**
 * stopSignal.ts — strips Session-Manager's own `<<<SM_NEEDS_INPUT>>>` stop-
 * signal protocol block off the END of an assistant turn's text, mirroring
 * `src/main/chatRunner.cjs`'s `splitStopSignal`.
 *
 * Why this exists: when a run ends by asking a question, `chatRunner.cjs`
 * emits `chat:run:needs-input` with `answerBody` — the reply text with the
 * trailing `<<<SM_NEEDS_INPUT>>>` + questions-JSON block already stripped.
 * The JSONL transcript feed, meanwhile, records the assistant text VERBATIM
 * — sentinel block included — since `classifyTranscriptLine.cjs` emits a
 * text block as-is. The two sources therefore carry different text for the
 * same message: `turnIdentity` in `state/chat.ts` must treat them as one
 * identity (this module's job), and whichever copy survives must not show
 * raw protocol JSON to the user (`ChatTranscriptTurn.tsx`'s job, using this
 * module at render time).
 *
 * This is the mirror-image of `promptPreamble.ts`: that module strips
 * something INJECTED onto the FRONT of a user turn; this strips something
 * APPENDED to the END of an assistant turn. Same reason for existing as a
 * duplicated renderer-side copy: the main-process `.cjs` cannot be imported
 * from the renderer (CommonJS main / ESM renderer split), so the constant is
 * copied here and `src/main/__tests__/chat-preamble-anchors.test.cjs`-style
 * drift coverage (`stop-signal-anchor.test.cjs`) asserts it stays
 * byte-identical to the real exported `STOP_SENTINEL`.
 */

/** Byte-identical to `STOP_SENTINEL` exported from `src/main/chatRunner.cjs`. */
export const STOP_SENTINEL = '<<<SM_NEEDS_INPUT>>>'

export interface SplitStopSignal {
  /** The reply text with the sentinel block removed, trimmed. */
  body: string
  /** The sentinel line + its questions-JSON tail, verbatim. */
  signalBlock: string
}

/**
 * Peel a trailing stop-signal block off assistant text.
 *
 * Mirrors `chatRunner.cjs`'s `splitStopSignal`: finds the LAST occurrence of
 * the sentinel (so a human quoting it earlier in a long reply is never
 * mistaken for the real one), requires what follows to parse as JSON with an
 * array `questions` field, and returns null otherwise — a human quoting the
 * sentinel with no valid JSON tail, or any other non-matching text, is left
 * fully intact rather than guessed at.
 */
export function splitStopSignal(text: string): SplitStopSignal | null {
  if (typeof text !== 'string') return null
  const idx = text.lastIndexOf(STOP_SENTINEL)
  if (idx === -1) return null
  const after = text.slice(idx + STOP_SENTINEL.length)
  const parsed = extractJson(after)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { questions?: unknown }).questions)) {
    return null
  }
  return { body: text.slice(0, idx).trim(), signalBlock: text.slice(idx) }
}

/** Minimal balanced-`{...}` JSON extractor — mirrors `main/lib/extractJson.cjs`. */
function extractJson(text: string): unknown {
  if (!text) return null
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
