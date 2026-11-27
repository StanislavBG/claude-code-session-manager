/**
 * epicOrigin — reads an Epic's `source` provenance stamp into the one thing
 * the queue actually needs to show: "this session was proposed by ANOTHER
 * project, here's which one".
 *
 * Why it needs saying on screen. A cross-project feedback Epic
 * (src/main/lib/feedback-remote/crossProjectFeedback.cjs) lands in this project's queue as a
 * plain `proposed` row, visually identical to one the human here filed
 * themselves. Approve & start is a spend decision, and it is a different
 * decision when the claim came from an agent that has never read this
 * codebase. The origin is already carried on the Epic — this module is just
 * the read side, kept pure so the chip's text is testable without rendering.
 */

import type { InboundProposal, PromptSession } from '../state/promptSessions'
import { basename } from './basename'

export interface InboundFeedbackOrigin {
  /** Absolute cwd of the project that sent this proposal. */
  fromCwd: string
  /** The sending Epic's id, when it was resolvable at send time. */
  fromEpicId?: string
  /** Short chip text — the sending project's folder name, never the full
   *  path (queue rows are narrow; the full path goes in the title). */
  label: string
  /** Hover text: the full path, and the honest caveat that goes with it. */
  title: string
  /** Structured plan from the sender; null for legacy/malformed Epics. */
  proposal: InboundProposal | null
  /** 'Part 5 of 7 · Series title', or null when not part of a series. */
  seriesLabel: string | null
}

/**
 * Returns the inbound-feedback origin of an Epic, or null when it wasn't
 * proposed by another project. Null for every locally-created Epic — including
 * ones with a `source` stamp from another producer — so callers can render the
 * chip unconditionally on the result.
 *
 * Complexity: O(n) in the cwd's length.
 */
export function inboundFeedbackOrigin(epic: Pick<PromptSession, 'source'>): InboundFeedbackOrigin | null {
  const source = epic.source
  if (!source || source.producer !== 'cross-project-feedback') return null
  const fromCwd = source.fromCwd
  if (!fromCwd) return null
  const proposal = normalizeProposal(source.proposal)
  const series = proposal?.series ?? null
  const auto = source.autoApprove
  const macroLabel = auto?.requestedBy === 'macro' ? auto.macroLabel : null
  const serviceName = auto?.requestedBy === 'service' ? auto.serviceName : null
  const tail =
    (source.fromEpicId ? ` (session ${source.fromEpicId})` : '')
    + (proposal?.originAsk ? ` — raised while working on: ${proposal.originAsk}` : '')
  const fromName = basename(fromCwd)
  const replyOf = threadRef(source.replyOf)
  const replyTo = threadRef(source.replyTo)
  const baseLabel = macroLabel ? `${fromName} · ${macroLabel}` : serviceName ? `${fromName} · ${serviceName}` : fromName
  const baseTitle = macroLabel
    ? `Auto-started by macro "${macroLabel}" from ${fromCwd}${tail}.`
    : serviceName
      ? `Auto-started by service "${serviceName}" from ${fromCwd}${tail}.`
    : `Proposed by another project: ${fromCwd}${tail}`
      + '. Verify the claim against this codebase before approving — the sender has not read it.'
  return {
    fromCwd,
    ...(source.fromEpicId ? { fromEpicId: source.fromEpicId } : {}),
    label: replyOf ? `${baseLabel} · reply to ${replyOf.epicId}` : baseLabel,
    title:
      (replyOf ? `Reply to Epic ${replyOf.epicId} from ${fromName}. ` : '')
      + baseTitle
      + (replyTo
        ? ` Asked by session ${replyTo.epicId} in ${basename(replyTo.cwd) || replyTo.cwd}`
          + ' — answer it with feedback_reply.'
        : ''),
    proposal,
    seriesLabel: series ? `Part ${series.index} of ${series.total} · ${series.title}` : null,
  }
}

/** Defensive read of a stored reply-thread link (`source.replyTo` /
 *  `source.replyOf`): null unless it carries a string epicId and cwd. */
function threadRef(raw: unknown): { cwd: string; epicId: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.epicId !== 'string' || !r.epicId || typeof r.cwd !== 'string' || !r.cwd) return null
  return { cwd: r.cwd, epicId: r.epicId }
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** Defensive read of a stored proposal: null when absent or structurally
 *  wrong; a malformed `series` alone only drops the series. */
function normalizeProposal(raw: unknown): InboundProposal | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.motivation !== 'string') return null
  if (!isStringArray(p.plan) || !isStringArray(p.acceptanceCriteria) || !isStringArray(p.outOfScope)) return null
  const s = p.series as Record<string, unknown> | null | undefined
  const series =
    s && typeof s === 'object'
    && typeof s.key === 'string' && typeof s.title === 'string'
    && Number.isInteger(s.index) && Number.isInteger(s.total)
      ? { key: s.key, title: s.title, index: s.index as number, total: s.total as number }
      : null
  return {
    motivation: p.motivation,
    originAsk: typeof p.originAsk === 'string' && p.originAsk ? p.originAsk : null,
    plan: p.plan,
    acceptanceCriteria: p.acceptanceCriteria,
    outOfScope: p.outOfScope,
    series,
  }
}

export interface InboundSeriesSibling {
  id: string
  index: number
  status: PromptSession['status']
  goalText: string
}

/** Epics in `epics` that share this Epic's proposal series key, by index.
 *  [] when the Epic has no series. Complexity: O(n log n). */
export function inboundSeriesSiblings(
  epic: Pick<PromptSession, 'source'>,
  epics: ReadonlyArray<Pick<PromptSession, 'id' | 'status' | 'goalText' | 'source'>>,
): InboundSeriesSibling[] {
  const key = normalizeProposal(epic.source?.proposal)?.series?.key
  if (!key) return []
  const out: InboundSeriesSibling[] = []
  for (const e of epics) {
    const s = normalizeProposal(e.source?.proposal)?.series
    if (s && s.key === key) out.push({ id: e.id, index: s.index, status: e.status, goalText: e.goalText })
  }
  return out.sort((a, b) => a.index - b.index)
}
