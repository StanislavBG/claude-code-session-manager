// Formatters shared across the History analytics view's control bar,
// headline, ranking table, and panels. Kept framework-free/pure so they're
// unit-testable without mounting any component.

export function usd(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  const decimals = Math.abs(v) < 1 ? 4 : 2
  return `$${v.toFixed(decimals)}`
}

export function tok(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return `${Math.round(v)}`
}

export function int(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  return Math.round(v).toLocaleString('en-US')
}

export function min(n: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(n) ? n : 0))
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

export function pct(n: number): string {
  if (!Number.isFinite(n)) return '0.0%'
  if (n > 0 && n < 1) return '<1%'
  return `${n.toFixed(1)}%`
}
