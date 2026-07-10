// Single source of truth for renderer chart colors — categorical series + sequential heat ramp.

export const CHART_CATEGORICAL: string[] = [
  '#60a5fa', '#34d399', '#f59e0b', '#f87171', '#a78bfa',
  '#fb923c', '#38bdf8', '#4ade80', '#e879f9', '#fbbf24',
]

export function categoricalColor(i: number): string {
  return CHART_CATEGORICAL[i % CHART_CATEGORICAL.length]
}

// Sequential intensity ramp for heatmaps: index 0 = no activity, 1-4 = increasing intensity.
export const HEAT_RAMP: readonly string[] = ['#2c2c2a', '#104281', '#256abf', '#3987e5', '#9ec5f4']
