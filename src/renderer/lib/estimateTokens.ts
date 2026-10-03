/** Rough token estimate for display only (~4 chars/token) — never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
