// Cumulative stacked-area band math for the History analytics trend chart.
// Returns the underlying per-band series (plain numbers), not SVG path
// strings, so the component owns rendering and this stays unit-testable.

export interface StackedDayInput {
  date: string
  values: Record<string, number>
}

export interface StackedDayBand {
  projectDir: string
  value: number
  y0: number
  y1: number
}

export interface StackedDay {
  date: string
  bands: StackedDayBand[]
  total: number
}

export type StackedMode = 'absolute' | 'share'

/** Bands are ordered by all-time total descending — the biggest project sits at the bottom of the stack. */
export function computeStackedBands(days: StackedDayInput[], mode: StackedMode): StackedDay[] {
  const totalsByProject = new Map<string, number>()
  for (const d of days) {
    for (const [p, v] of Object.entries(d.values)) {
      totalsByProject.set(p, (totalsByProject.get(p) ?? 0) + v)
    }
  }
  const order = Array.from(totalsByProject.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)

  return days.map((d) => {
    const dayTotal = order.reduce((sum, p) => sum + (d.values[p] ?? 0), 0)
    let cum = 0
    const bands: StackedDayBand[] = order.map((p) => {
      const raw = d.values[p] ?? 0
      if (dayTotal <= 0) return { projectDir: p, value: raw, y0: 0, y1: 0 }
      const v = mode === 'share' ? raw / dayTotal : raw
      const y0 = cum
      const y1 = cum + v
      cum = y1
      return { projectDir: p, value: raw, y0, y1 }
    })
    return { date: d.date, bands, total: dayTotal }
  })
}
