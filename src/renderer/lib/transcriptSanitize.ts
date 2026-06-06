/**
 * Collapse pathological repetition in ASR output.
 *
 * Autoregressive speech-to-text decoders (Whisper, Moonshine) can fall into a
 * repetition loop on silence, low-quality, or overlong audio and emit the same
 * word or phrase dozens of times verbatim — e.g. "…create a web connection. So
 * that we can create a web connection. So that we can create a web connection…".
 * The model fix is generation-time (no_repeat_ngram_size); this is the
 * defense-in-depth backstop that runs on the produced text regardless of model
 * or library behaviour.
 *
 * Collapses any unit of 1..maxPhraseLen words repeated MORE THAN maxRepeats times
 * consecutively down to a single occurrence. Legitimate short repeats ("no no
 * no") are preserved. The longest repeating unit wins, so "a b a b a b…" folds
 * on the phrase "a b", not the word "a". Punctuation stays attached to its word
 * so "x. x. x." collapses too.
 *
 * Pure. Time: O(n · maxPhraseLen) over the word count (the cursor jumps past
 * each collapsed run, so the per-position scan does not compound). Space: O(n).
 */
export function collapseRepetition(
  text: string,
  { maxRepeats = 3, maxPhraseLen = 8 }: { maxRepeats?: number; maxPhraseLen?: number } = {},
): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  if (words.length < 2) return text // need ≥2 words for any repeat

  const phraseEq = (aStart: number, bStart: number, len: number): boolean => {
    for (let k = 0; k < len; k++) {
      if (words[aStart + k] !== words[bStart + k]) return false
    }
    return true
  }

  const out: string[] = []
  let i = 0
  while (i < words.length) {
    let collapsed = false
    const maxLen = Math.min(maxPhraseLen, Math.floor((words.length - i) / 2))
    // Longest repeating unit first so a repeating phrase isn't mis-folded as a
    // repeating single word.
    for (let len = maxLen; len >= 1; len--) {
      let reps = 1
      while (i + (reps + 1) * len <= words.length && phraseEq(i, i + reps * len, len)) {
        reps++
      }
      if (reps > maxRepeats) {
        for (let k = 0; k < len; k++) out.push(words[i + k]) // keep one copy
        i += reps * len
        collapsed = true
        break
      }
    }
    if (!collapsed) {
      out.push(words[i])
      i++
    }
  }
  return out.join(' ')
}
