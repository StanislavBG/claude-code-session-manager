/**
 * Which models the CLI applies `effort` to — read at runtime from the bundled settings
 * schema's `effortLevel` description ("Effort is supported on Fable 5, Opus 4.8, ...") so
 * the model list is never hardcoded in a component.
 */
import rawSchema from '../data/claude-settings-schema.json'
import { modelFamily } from './prettyModel'

interface Entry { family: string; version: number }

const versionNum = (v: string): number => {
  const [maj, min] = v.split('.')
  return Number(maj) + (min ? Number(min) / 100 : 0)
}

/** Parse "Fable 5, Opus 4.8, ... and Sonnet 4.6" out of the schema description. O(len). */
export function parseSupported(description: string): Entry[] {
  const m = /Effort is supported on ([^.]*?)(?:, with|\.|$)/.exec(description)
  if (!m) return []
  const out: Entry[] = []
  for (const part of m[1].split(/,\s*|\s+and\s+/)) {
    const e = /^(\w+)\s+(\d+(?:\.\d+)?)$/.exec(part.trim())
    if (e) out.push({ family: e[1].toLowerCase(), version: versionNum(e[2]) })
  }
  return out
}

const SUPPORTED: Entry[] = parseSupported(
  String((rawSchema as { properties?: { effortLevel?: { description?: string } } }).properties?.effortLevel?.description ?? ''),
)

/** `claude-opus-4-8` → 4.08, `claude-opus-5` → 5, `claude-3-5-sonnet` → 3.05; null for a bare alias. */
function concreteVersion(id: string, family: string): number | null {
  const after = new RegExp(`${family}-(\\d+)(?:-(\\d{1,2})(?!\\d))?`, 'i').exec(id)
  if (after) return Number(after[1]) + (after[2] ? Number(after[2]) / 100 : 0)
  const before = new RegExp(`claude-(\\d+)(?:-(\\d{1,2}))?-${family}`, 'i').exec(id)
  return before ? Number(before[1]) + (before[2] ? Number(before[2]) / 100 : 0) : null
}

/**
 * false = model is KNOWN not to support effort (family not in the list, or an older version than
 * the oldest listed); true = supported or newer than the list; null = unknown (inherit / alias
 * resolving to whatever is latest / unrecognised id).
 */
export function modelSupportsEffort(model: string, supported: Entry[] = SUPPORTED): boolean | null {
  if (!model || model === 'inherit' || supported.length === 0) return null
  const family = modelFamily(model)
  if (!family) return null
  const listed = supported.filter((s) => s.family === family)
  if (listed.length === 0) return false
  const v = concreteVersion(model, family)
  if (v === null) return null
  return v >= Math.min(...listed.map((s) => s.version))
}
