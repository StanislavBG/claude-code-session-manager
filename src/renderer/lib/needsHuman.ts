/**
 * needsHuman — the single definition of "needs you" for every surface.
 *
 * Needs you = an open question from a chat run: the Epic's chat has a ticket
 * with status 'needs-input'. A needs_review park, a failed job or a running
 * fix is never shown as a question.
 *
 * Pure: no window access, no React.
 */

/** True only when this Epic's chat has a ticket with status 'needs-input'. */
export function epicHasOpenQuestion(
  epicId: string,
  chats: Record<string, { ticketHistory?: { status: string }[] }>,
): boolean {
  const chat = chats[epicId]
  return (chat?.ticketHistory ?? []).some((t) => t.status === 'needs-input')
}

/** Case-insensitive substrings of job.error → one plain cause sentence. First match wins. */
const PARK_CAUSES: ReadonlyArray<{ needles: readonly string[]; cause: string }> = [
  { needles: ['worktree_integration_failed', 'refusing to integrate'], cause: 'Its commit could not be merged yet.' },
  { needles: ['sentinel_fail'], cause: 'Its checks did not pass.' },
  { needles: ['no_verdict', 'no verdict'], cause: 'It ended without a verdict.' },
]

/** One calm line for a parked (needs_review) PRD — it is the scheduler's job, never the human's. */
export function parkedJobLine(job: { slug: string; error?: string | null }): string {
  const base = `PRD ${job.slug} is parked and the scheduler is fixing it — nothing is needed from you.`
  const error = (job.error ?? '').toLowerCase()
  if (!error) return base
  const hit = PARK_CAUSES.find((c) => c.needles.some((n) => error.includes(n)))
  return hit ? `${base} ${hit.cause}` : base
}
