export type FormatCompactCountOptions = {
  // 'lower' -> 340k (Usage tab); 'upper' -> 340K (History tab)
  suffixCase?: 'upper' | 'lower'
  // decimal places for the K/k bucket (Usage: 0 -> "340k", History: 1 -> "1.5K")
  kDecimals?: number
}

// Compact count formatting (1.2M / 340k / 12) shared by the Usage tab
// (TopologyHeader, SessionMatrix) and HistoryDashboard so all token-count
// displays never drift apart.
export function formatCompactCount(n: number, opts: FormatCompactCountOptions = {}): string {
  const { suffixCase = 'lower', kDecimals = 0 } = opts
  const suffix = suffixCase === 'upper' ? { k: 'K', m: 'M' } : { k: 'k', m: 'M' }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}${suffix.m}`
  if (n >= 1_000) return `${(n / 1_000).toFixed(kDecimals)}${suffix.k}`
  return n.toFixed(0)
}
