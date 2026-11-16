import { useMemo } from 'react'
import type { PromptSessionEvent } from '../../state/promptSessions'
import { renderChatMarkdown } from '../../lib/renderChatMarkdown'
import { STATUS_TONE } from '../tabs/scheduler/sched-primitives'

/**
 * A cross-project reply (feedback_reply) lands in the asking Epic as a
 * 'response' event with `notice: 'cross-project-reply'` + `reply` metadata.
 * This card sets it apart from the agent's own prose: which project replied,
 * the outcome, the message, and the paths it points at. The sender's own
 * Epic gets a 'cross-project-reply-sent' receipt, rendered as one line.
 * Presentational; the text is main's — rendered as-is, never rewritten here.
 */

type Outcome = NonNullable<PromptSessionEvent['reply']>['outcome']

// Reuse the PRD status pill palette so the chip reads in light and dark.
const OUTCOME_TONE: Record<Outcome, { bg: string; text: string }> = {
  done: STATUS_TONE.completed,
  blocked: STATUS_TONE.failed,
  question: STATUS_TONE.needs_review,
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

export function CrossProjectReplyCard({ event }: { event: PromptSessionEvent }) {
  const textHtml = useMemo(() => renderChatMarkdown(event.text ?? ''), [event.text])
  const reply = event.reply
  const from = reply?.fromCwd ? basename(reply.fromCwd) : 'another project'
  const tone = reply ? OUTCOME_TONE[reply.outcome] : undefined
  const refs = reply?.referencePaths ?? []

  return (
    <div
      data-testid="cross-project-reply-card"
      data-notice={event.notice}
      aria-label={`Reply from ${from}${reply ? ` (${reply.outcome})` : ''}: ${event.text ?? ''}`}
      className="break-words rounded-lg border border-rule bg-bg px-3 py-2 text-left text-[12px] text-fg"
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          data-testid="cross-project-reply-from"
          className="font-mono text-[10px] font-semibold uppercase tracking-wide text-fg-dim"
        >
          Reply from {from}
        </span>
        {reply && tone && (
          <span
            data-testid="cross-project-reply-outcome"
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${tone.bg} ${tone.text}`}
          >
            {reply.outcome}
          </span>
        )}
      </div>
      <div
        data-testid="cross-project-reply-text"
        className="prose-chat [&_*]:m-0"
        dangerouslySetInnerHTML={{ __html: textHtml }}
      />
      {refs.length > 0 && (
        <ul
          data-testid="cross-project-reply-references"
          aria-label="Reference paths"
          className="mt-1.5 list-disc pl-4 font-mono text-[11px] text-fg-dim"
        >
          {refs.map((p) => (
            <li key={p} className="break-all">{p}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function CrossProjectReplyReceipt({ event }: { event: PromptSessionEvent }) {
  return (
    <div
      data-testid="cross-project-reply-receipt"
      data-notice={event.notice}
      className="truncate text-center text-[11px] text-fg-faint"
      title={event.text ?? ''}
    >
      <span aria-hidden="true">↩ </span>
      {event.text || 'Reply sent'}
    </div>
  )
}
