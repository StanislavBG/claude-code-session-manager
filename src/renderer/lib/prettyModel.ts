/**
 * Compress long model identifiers for compact pill display.
 *
 * Handles three shapes:
 *   claude-opus-4-7[1m]            → "Opus 4.7 1m"
 *   claude-sonnet-4-6-20250514     → "Sonnet 4.6"
 *   claude-haiku-4-5               → "Haiku 4.5"
 *
 * Falls back to the input string when no known family is found. The
 * AppStatusBar pill and TeamsCard chip used to have separate, drifting
 * implementations of this; unified here.
 */
export function prettyModel(model: string): string {
  if (!model || model === '—' || model === 'unknown') return model
  const ctx = /\[(\dm)\]/.exec(model)
  const m = /(opus|sonnet|haiku)[-_](\d+)[-_.]?(\d+)?/i.exec(model)
  if (!m) return model
  const fam = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
  const ver = m[3] ? `${m[2]}.${m[3]}` : m[2]
  return ctx ? `${fam} ${ver} ${ctx[1]}` : `${fam} ${ver}`
}
