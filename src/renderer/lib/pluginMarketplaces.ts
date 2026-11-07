import { toast } from '../state/toast'

/** One plugin advertised by a marketplace Claude Code already knows about. */
export interface MarketplacePlugin {
  marketplace: string
  name: string
  description: string
  source: string
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** marketplace.json `source` is a relative path string or a {source,url|repo|path} object. */
function sourceOf(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (isObj(raw)) {
    for (const k of ['url', 'repo', 'path']) {
      if (typeof raw[k] === 'string') return raw[k] as string
    }
  }
  return ''
}

/**
 * Plugins from every marketplace in ~/.claude/plugins/known_marketplaces.json,
 * read from each marketplace's .claude-plugin/marketplace.json on disk. A
 * missing/invalid file is skipped and toasted; this never throws.
 */
export async function listMarketplacePlugins(home: string): Promise<MarketplacePlugin[]> {
  const root = `${home}/.claude/plugins`
  const out: MarketplacePlugin[] = []
  let known: Record<string, unknown>
  try {
    const r = await window.api.config.readJson(`${root}/known_marketplaces.json`)
    if (r.parseError || r.error) {
      toast.error(`known_marketplaces.json unreadable: ${r.parseError ?? r.error}`)
      return out
    }
    if (!r.exists) return out
    if (!isObj(r.data)) {
      toast.error('known_marketplaces.json is not an object')
      return out
    }
    known = r.data
  } catch (err) {
    toast.error(`known_marketplaces.json unreadable: ${err instanceof Error ? err.message : String(err)}`)
    return out
  }

  for (const [mkt, entry] of Object.entries(known)) {
    const loc = isObj(entry) && typeof entry.installLocation === 'string' ? entry.installLocation : `${root}/marketplaces/${mkt}`
    const file = `${loc}/.claude-plugin/marketplace.json`
    try {
      const r = await window.api.config.readJson(file)
      if (!r.exists) {
        toast.warn(`Marketplace ${mkt}: ${file} not found`)
        continue
      }
      if (r.parseError || r.error || !isObj(r.data) || !Array.isArray(r.data.plugins)) {
        toast.error(`Marketplace ${mkt}: invalid marketplace.json${r.parseError ? ` — ${r.parseError}` : ''}`)
        continue
      }
      for (const p of r.data.plugins) {
        if (!isObj(p) || typeof p.name !== 'string' || !p.name) continue
        out.push({
          marketplace: mkt,
          name: p.name,
          description: typeof p.description === 'string' ? p.description : '',
          source: sourceOf(p.source),
        })
      }
    } catch (err) {
      toast.error(`Marketplace ${mkt}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}
