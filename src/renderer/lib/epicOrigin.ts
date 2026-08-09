/**
 * epicOrigin — reads an Epic's `source` provenance stamp into the one thing
 * the queue actually needs to show: "this session was proposed by ANOTHER
 * project, here's which one".
 *
 * Why it needs saying on screen. A cross-project feedback Epic
 * (src/main/lib/crossProjectFeedback.cjs) lands in this project's queue as a
 * plain `proposed` row, visually identical to one the human here filed
 * themselves. Approve & start is a spend decision, and it is a different
 * decision when the claim came from an agent that has never read this
 * codebase. The origin is already carried on the Epic — this module is just
 * the read side, kept pure so the chip's text is testable without rendering.
 */

import type { PromptSession } from '../state/promptSessions'

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
}

/** Last non-empty path segment, POSIX or Windows separators. Falls back to
 *  the whole string when there is no separator to split on. */
function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : p
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
  return {
    fromCwd,
    ...(source.fromEpicId ? { fromEpicId: source.fromEpicId } : {}),
    label: baseName(fromCwd),
    title:
      `Proposed by another project: ${fromCwd}`
      + (source.fromEpicId ? ` (session ${source.fromEpicId})` : '')
      + '. Verify the claim against this codebase before approving — the sender has not read it.',
  }
}
