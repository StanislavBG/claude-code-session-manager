/**
 * npm registry update checker.
 *
 * Polled once per Overview mount (component-level). Result is cached in
 * localStorage keyed by current version + UTC date so repeated navigation
 * within a day doesn't re-hit the registry (which rate-limits per IP).
 *
 * CSP note: `connect-src` in src/main/index.cjs must include
 * https://registry.npmjs.org or fetch silently fails.
 */

const REGISTRY_URL = 'https://registry.npmjs.org/claude-code-session-manager/latest'
const CACHE_KEY_PREFIX = 'sm.updateCheck.v1'

export interface UpdateCheckResult {
  latest: string
  isNewer: boolean
}

/**
 * Parse "X.Y.Z" into three numbers. Pre-release suffixes (e.g. "1.2.3-beta")
 * are stripped — we only compare the numeric core.
 * O(1).
 */
function parseTriplet(v: string): [number, number, number] {
  const core = v.split('-')[0].split('+')[0]
  const parts = core.split('.')
  const n0 = Number(parts[0] ?? 0) || 0
  const n1 = Number(parts[1] ?? 0) || 0
  const n2 = Number(parts[2] ?? 0) || 0
  return [n0, n1, n2]
}

/**
 * Compare two semver-ish strings. Returns positive if a > b, negative if
 * a < b, 0 if equal. O(1).
 */
export function compareVersions(a: string, b: string): number {
  const [a0, a1, a2] = parseTriplet(a)
  const [b0, b1, b2] = parseTriplet(b)
  if (a0 !== b0) return a0 - b0
  if (a1 !== b1) return a1 - b1
  return a2 - b2
}

function todayKey(currentVersion: string): string {
  // UTC date is fine here — we just want "once per day per version".
  const d = new Date()
  const ymd = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`
  return `${CACHE_KEY_PREFIX}.${currentVersion}.${ymd}`
}

function readCache(currentVersion: string): UpdateCheckResult | null {
  try {
    const raw = localStorage.getItem(todayKey(currentVersion))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UpdateCheckResult>
    if (typeof parsed.latest === 'string' && typeof parsed.isNewer === 'boolean') {
      return { latest: parsed.latest, isNewer: parsed.isNewer }
    }
    return null
  } catch {
    return null
  }
}

function writeCache(currentVersion: string, result: UpdateCheckResult): void {
  try {
    localStorage.setItem(todayKey(currentVersion), JSON.stringify(result))
  } catch {
    /* localStorage may be full / disabled — ignore */
  }
}

/**
 * Fetch the latest published version from the npm registry and compare to
 * `currentVersion`. Returns null on any error (network, parse, CSP block).
 *
 * O(1) — one HTTP roundtrip, trivial JSON parse, fixed-size compare.
 */
export async function checkForUpdate(
  currentVersion: string,
): Promise<UpdateCheckResult | null> {
  const cached = readCache(currentVersion)
  if (cached) return cached

  try {
    const res = await fetch(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.warn('[updateCheck] registry returned', res.status)
      return null
    }
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== 'string') {
      console.warn('[updateCheck] registry payload missing version field')
      return null
    }
    const latest = body.version
    const isNewer = compareVersions(latest, currentVersion) > 0
    const result: UpdateCheckResult = { latest, isNewer }
    writeCache(currentVersion, result)
    return result
  } catch (e) {
    console.warn('[updateCheck] fetch failed:', e)
    return null
  }
}
