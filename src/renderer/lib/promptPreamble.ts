/**
 * promptPreamble.ts — strips Session-Manager's own injected instruction
 * blocks off the front of a user turn so the feed shows what the HUMAN typed.
 *
 * Why this exists: `chatRunner.cjs` prepends two fixed instruction blocks to
 * every prompt before handing it to `claude -p` (`STOP_SIGNAL_INSTRUCTION` +
 * `CHAT_MODE_TRUTH_INSTRUCTION`, composed as `fullPrompt` at its `-p` call
 * site). The durable exchange log records the clean `prompt`, but the CLI's
 * own JSONL records what it was actually sent — so the transcript feed
 * (`ingestTranscriptEvent`) rebuilds user turns containing ~1,400 characters
 * of machine boilerplate with the human's actual sentence buried at the
 * bottom. That is what this module cuts.
 *
 * ── Why match on anchors rather than the literal strings ──────────────────
 * Those constants live in a main-process `.cjs` the renderer cannot import
 * (see EpicTerminalPane's resolveEpicModel for the same constraint). Copying
 * two full paragraphs here would rot the moment either is reworded. Instead
 * each block is anchored on its FIRST and LAST sentence only — the parts that
 * carry the block's identity — so ordinary edits to the middle keep matching.
 * `src/main/__tests__/chat-preamble-anchors.test.cjs` asserts the real
 * exported constants still satisfy these anchors, so a rewording that DOES
 * break them fails CI rather than silently un-hiding the boilerplate.
 *
 * Pure and non-destructive: nothing is deleted from the store, and
 * `splitInjectedPreamble` refuses to strip anything it isn't sure about.
 */

export interface InjectedBlockDef {
  key: string
  /** Human-facing name for the disclosure UI. */
  label: string
  /** Exact opening sentence — must appear at the cursor for the block to match. */
  start: string
  /** Exact closing sentence — the block ends immediately after it. */
  end: string
}

export const INJECTED_PROMPT_BLOCKS: InjectedBlockDef[] = [
  {
    key: 'stop-signal',
    label: 'Stop-signal protocol',
    start: 'IMPORTANT: First deliver everything you CAN answer',
    end: 'Otherwise complete the task and end with a concise summary of what you did.',
  },
  {
    key: 'chat-mode-truth',
    label: 'One-shot headless run',
    start: 'IMPORTANT: This is a one-shot headless run.',
    end: 'reply for the work to continue.',
  },
]

export interface SplitPrompt {
  /** The injected boilerplate, verbatim, or null when none was found. */
  preamble: string | null
  /** Keys of the blocks matched, in the order they appeared. */
  blockKeys: string[]
  /** What the human actually typed — equals the input when preamble is null. */
  body: string
}

/**
 * Peel known injected blocks off the front of a prompt.
 *
 * Matching is anchored at a cursor that only ever moves forward, so a block's
 * text appearing LATER in the human's own message (e.g. a user quoting the
 * boilerplate, as happens when debugging it) is never stripped.
 *
 * Refuses to strip — returning `{ preamble: null, body: text }` — when:
 *   • no known block starts the text,
 *   • a block's opening sentence matches but its closing sentence is missing
 *     (a truncated or reworded block; better to over-show than to eat the
 *     human's words), or
 *   • stripping would leave an EMPTY body (the prompt was boilerplate only —
 *     an empty bubble is strictly worse than a verbose one).
 */
export function splitInjectedPreamble(text: string): SplitPrompt {
  const untouched: SplitPrompt = { preamble: null, blockKeys: [], body: text }
  if (typeof text !== 'string' || !text) return untouched

  let cursor = text.length - text.trimStart().length
  const blockKeys: string[] = []
  const used = new Set<string>()

  // Loop rather than a fixed sequence: the blocks may be reordered, either
  // may be absent, and neither should depend on the other being present.
  for (;;) {
    let advanced = false
    for (const def of INJECTED_PROMPT_BLOCKS) {
      if (used.has(def.key)) continue
      if (!text.startsWith(def.start, cursor)) continue
      const endAt = text.indexOf(def.end, cursor + def.start.length)
      if (endAt === -1) return untouched // opening matched, closing didn't — bail out whole
      let next = endAt + def.end.length
      while (next < text.length && /\s/.test(text[next])) next++
      cursor = next
      used.add(def.key)
      blockKeys.push(def.key)
      advanced = true
      break
    }
    if (!advanced) break
  }

  if (blockKeys.length === 0) return untouched
  const body = text.slice(cursor)
  if (!body.trim()) return untouched
  return { preamble: text.slice(0, cursor).trim(), blockKeys, body }
}

/** Label list for the disclosure tooltip, e.g. "Stop-signal protocol, One-shot headless run". */
export function describeInjectedBlocks(blockKeys: string[]): string {
  return blockKeys
    .map((k) => INJECTED_PROMPT_BLOCKS.find((b) => b.key === k)?.label ?? k)
    .join(', ')
}
