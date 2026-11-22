/**
 * Pure helpers for the Project Home MD network explorer's doc preview and docs
 * table: a plain-language usage line per doc, staleness/currency flags and
 * relative ages. No React, no window access.
 */
import type { MdDoc } from '../../preload/api'

export const STALE_DAYS = 90

const DAY_MS = 86_400_000

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
