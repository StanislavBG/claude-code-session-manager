// Builds the History analytics "Export CSV" file client-side from the
// already-loaded dashboard payload — no IPC round-trip.
import { prettyModel } from './prettyModel'

export interface CsvModelBucket {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface CsvDayInput {
  date: string
  costUsd: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  byModel: Record<string, CsvModelBucket>
}

const HEADER = [
  'date', 'cost_usd', 'input_tokens', 'output_tokens', 'cache_write_tokens',
  'cache_read_tokens', 'total_tokens', 'cache_hit_pct', 'num_models', 'top_model',
]

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function modelTotal(b: CsvModelBucket): number {
  return b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheCreationTokens
}

export function buildUsageCsv(days: CsvDayInput[]): string {
  const rows = days.map((d) => {
    const totalTokens = d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens
    const denom = d.inputTokens + d.cacheReadTokens + d.cacheCreationTokens
    const cacheHitPct = denom > 0 ? (d.cacheReadTokens / denom) * 100 : 0

    const activeModels = Object.entries(d.byModel).filter(([, b]) => modelTotal(b) > 0)
    let topModel = ''
    let topTotal = -1
    for (const [modelId, b] of activeModels) {
      const t = modelTotal(b)
      if (t > topTotal) { topTotal = t; topModel = modelId }
    }

    const cells = [
      d.date,
      d.costUsd.toFixed(4),
      String(d.inputTokens),
      String(d.outputTokens),
      String(d.cacheCreationTokens),
      String(d.cacheReadTokens),
      String(totalTokens),
      cacheHitPct.toFixed(1),
      String(activeModels.length),
      topModel ? prettyModel(topModel) : '',
    ]
    return cells.map(csvEscape).join(',')
  })
  return [HEADER.join(','), ...rows].join('\n')
}
