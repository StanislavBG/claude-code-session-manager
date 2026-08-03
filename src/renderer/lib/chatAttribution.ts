/**
 * Attribution chip data for a chat turn (PRD chat-simplified-conversion-frame).
 * classifyTranscriptLine.cjs's makeRaw() already preserves every top-level
 * field on a JSONL line (attribution*, effort, gitBranch, isSidechain, isMeta,
 * isApiErrorMessage, interruptedByShutdown, …) into the event's `raw`
 * projection — chat.ts's ingestTranscriptEvent previously read only `raw.
 * timestamp`/`raw.isMeta`/`raw.isSidechain` off it and discarded the rest.
 * extractAttribution is the single place that turns that raw projection into
 * the small, bounded shape the header's attribution chips render from — a
 * pure function so both chat.ts (ingest) and the renderer's tests share one
 * implementation.
 */
export interface Attribution {
  attributionSkill?: string
  attributionPlugin?: string
  attributionMcpServer?: string
  attributionMcpTool?: string
  effort?: string
  gitBranch?: string
  isSidechain?: boolean
  isMeta?: boolean
  isApiErrorMessage?: boolean
  interruptedByShutdown?: boolean
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return v === true ? true : undefined
}

/** Returns undefined (not an empty object) when raw carries none of these
 *  fields, so callers can cheaply check "does this turn have any attribution
 *  at all" without inspecting keys. */
export function extractAttribution(raw: unknown): Attribution | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: Attribution = {}
  const set = <K extends keyof Attribution>(key: K, value: Attribution[K] | undefined) => {
    if (value !== undefined) out[key] = value
  }
  set('attributionSkill', str(r.attributionSkill))
  set('attributionPlugin', str(r.attributionPlugin))
  set('attributionMcpServer', str(r.attributionMcpServer))
  set('attributionMcpTool', str(r.attributionMcpTool))
  set('effort', str(r.effort))
  set('gitBranch', str(r.gitBranch))
  set('isSidechain', bool(r.isSidechain))
  set('isMeta', bool(r.isMeta))
  set('isApiErrorMessage', bool(r.isApiErrorMessage))
  set('interruptedByShutdown', bool(r.interruptedByShutdown))
  return Object.keys(out).length > 0 ? out : undefined
}
