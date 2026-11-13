/**
 * Pure helpers for the Project Home MD network explorer's curation tray: a
 * plain-language usage line per doc, staleness/currency flags, relative ages,
 * the `mdCuration` shape kept in per-project ui-prefs, and
 * `composeCurationBrief`, which turns the human's verdicts into the Scope and
 * additional instructions of a Review MD network launch.
 * No React, no window access.
 */
import type { MdCensus, MdDoc } from '../../preload/api'

export const STALE_DAYS = 90

export type MdVerdict = 'keep' | 'update' | 'merge' | 'delete'

export interface MdCuration {
  verdicts: Record<string, MdVerdict>
  notes: Record<string, string>
  reviewedAt: Record<string, number>
  recordFolders: string[]
  docFolders: string[]
}

export const EMPTY_CURATION: MdCuration = Object.freeze({
  verdicts: Object.freeze({}) as Record<string, MdVerdict>,
  notes: Object.freeze({}) as Record<string, string>,
  reviewedAt: Object.freeze({}) as Record<string, number>,
  recordFolders: Object.freeze([]) as unknown as string[],
  docFolders: Object.freeze([]) as unknown as string[],
}) as MdCuration

const DAY_MS = 86_400_000
const MAX_PATHS = 2000
const MAX_NOTE = 280
const MAX_FOLDERS = 50
const MAX_KEY = 4096
/** ipcSchemas.cjs caps a launch's extraInstructions at 4000 chars. */
const MAX_EXTRA = 4000
const MAX_SCOPE = 600
const MAX_SCOPE_DOCS = 8
const VERDICTS: readonly MdVerdict[] = ['keep', 'update', 'merge', 'delete']

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i + 1)
}

export function usageLine(doc: MdDoc): string {
  let base: string
  switch (doc.role) {
    case 'map':
      base = doc.path === 'CLAUDE.md' ? 'Entry map: loaded into every session' : 'Imported by CLAUDE.md: loaded into every session'
      break
    case 'scoped': {
      const dir = dirOf(doc.path)
      base = dir ? `Loaded when an agent works in ${dir}` : 'Loaded when an agent works in the project root'
      break
    }
    case 'agent':
      base = 'Loaded by name as a skill, agent, command or rule'
      break
    case 'record':
      base = `Machine-written record in ${doc.collection ?? (dirOf(doc.path) || 'the project root')}`
      break
    default:
      base = doc.depth != null ? `Reachable from CLAUDE.md in ${doc.depth} link(s)` : 'Nothing links here from CLAUDE.md'
  }
  if (doc.codeRefs > 0) base += ` · named by ${doc.codeRefs} code ${doc.codeRefs === 1 ? 'file' : 'files'}`
  return base
}

export type MdDocFlag = { flag: 'stale' | 'changed' | 'missing-refs' | 'unlinked'; label: string }

export function docFlags(doc: MdDoc, reviewedAtMs: number | null, nowMs: number): MdDocFlag[] {
  if (doc.role === 'record') return []
  const out: MdDocFlag[] = []
  const window = STALE_DAYS * DAY_MS
  const reviewedRecently = reviewedAtMs != null && nowMs - reviewedAtMs <= window
  const old = doc.lastCommitMs == null || nowMs - doc.lastCommitMs > window
  if (old && !reviewedRecently) {
    out.push({ flag: 'stale', label: doc.lastCommitMs == null ? 'no change in the scanned history' : `no change in ${STALE_DAYS}+ days` })
  }
  const changed = doc.changedSince.filter((c) => reviewedAtMs == null || c.ms > reviewedAtMs).length
  if (changed > 0) out.push({ flag: 'changed', label: `${changed} named file(s) changed since` })
  if (doc.deadRefs.length > 0) out.push({ flag: 'missing-refs', label: `${doc.deadRefs.length} missing path(s)` })
  if (doc.role === 'doc' && doc.depth == null) out.push({ flag: 'unlinked', label: 'unlinked' })
  return out
}

export function relativeAge(ms: number | null, nowMs: number): string {
  if (ms == null) return 'before the scanned history'
  const days = Math.floor((nowMs - ms) / DAY_MS)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function goodKey(k: string): boolean {
  return k.length > 0 && k.length <= MAX_KEY
}

function folders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const f of raw) {
    if (out.length >= MAX_FOLDERS) break
    if (typeof f === 'string' && goodKey(f) && !out.includes(f)) out.push(f)
  }
  return out
}

export function normalizeCuration(raw: unknown): MdCuration {
  const c: MdCuration = { verdicts: {}, notes: {}, reviewedAt: {}, recordFolders: [], docFolders: [] }
  try {
    if (!isRecord(raw)) return c
    if (isRecord(raw.verdicts)) {
      let n = 0
      for (const [k, v] of Object.entries(raw.verdicts)) {
        if (n >= MAX_PATHS) break
        if (goodKey(k) && typeof v === 'string' && (VERDICTS as readonly string[]).includes(v)) { c.verdicts[k] = v as MdVerdict; n++ }
      }
    }
    if (isRecord(raw.notes)) {
      let n = 0
      for (const [k, v] of Object.entries(raw.notes)) {
        if (n >= MAX_PATHS) break
        if (goodKey(k) && typeof v === 'string' && v.trim()) { c.notes[k] = v.slice(0, MAX_NOTE); n++ }
      }
    }
    if (isRecord(raw.reviewedAt)) {
      let n = 0
      for (const [k, v] of Object.entries(raw.reviewedAt)) {
        if (n >= MAX_PATHS) break
        if (goodKey(k) && typeof v === 'number' && Number.isFinite(v)) { c.reviewedAt[k] = v; n++ }
      }
    }
    c.recordFolders = folders(raw.recordFolders)
    c.docFolders = folders(raw.docFolders)
  } catch { /* malformed prefs never throw — keep what was salvaged */ }
  return c
}

const HEADER = 'Human curation from the Project Home MD network explorer. Treat each verdict as the human\'s decision: verify it against the code, then plan the changes.'
// Room for "\n… and N more not listed" with any realistic N.
const TRAILER_RESERVE = 40

/**
 * Builds a Review MD network launch's Scope + additional instructions from the
 * human's verdicts. Only verdicts on paths present in `census.docs` count.
 * `extraInstructions` is '' when there is nothing to say (no picked docs and no
 * folder overrides); otherwise it follows the explorer template and never
 * exceeds 4000 chars — items are added while they fit, then a
 * '… and N more not listed' trailer counts the rest.
 */
export function composeCurationBrief(c: MdCuration, census: MdCensus): { scope: string; extraInstructions: string; picked: number } {
  const known = new Set(census.docs.map((d) => d.path))
  const byVerdict: Record<MdVerdict, string[]> = { keep: [], update: [], merge: [], delete: [] }
  for (const [path, v] of Object.entries(c.verdicts)) {
    if (known.has(path) && byVerdict[v]) byVerdict[v].push(path)
  }
  const pickedPaths = VERDICTS.flatMap((v) => byVerdict[v].sort())
  const picked = pickedPaths.length

  let scope = 'the whole project'
  if (picked > 0) {
    const listed = `these docs: ${[...pickedPaths].sort().join(', ')}`
    scope = picked <= MAX_SCOPE_DOCS && listed.length <= MAX_SCOPE ? listed : `the ${picked} docs listed in the additional instructions`
  }

  const groups: { label: string; items: string[] }[] = [
    ...VERDICTS.map((v) => ({
      label: `${v.toUpperCase()}: `,
      items: byVerdict[v].map((p) => (c.notes[p] ? `${p} (note: ${c.notes[p]})` : p)),
    })),
    { label: 'Record folders (machine-written; keep them out of the map): ', items: c.recordFolders },
    { label: 'Count as docs, not records: ', items: c.docFolders },
  ].filter((g) => g.items.length > 0)

  if (groups.length === 0) return { scope, extraInstructions: '', picked }

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  let text = HEADER
  let added = 0
  let full = false
  for (const g of groups) {
    if (full) break
    let line = ''
    for (const item of g.items) {
      const next = line ? `${line}, ${item}` : `\n${g.label}${item}`
      if (text.length + next.length > MAX_EXTRA - TRAILER_RESERVE) { full = true; break }
      line = next
      added++
    }
    text += line
  }
  const rest = total - added
  if (rest > 0) text += `\n… and ${rest} more not listed`
  return { scope, extraInstructions: text.slice(0, MAX_EXTRA), picked }
}
