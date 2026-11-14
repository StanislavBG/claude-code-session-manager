import { useMemo, useState } from 'react'
import type { PromptSessionEvent } from '../../state/promptSessions'
import { renderChatMarkdown } from '../../lib/renderChatMarkdown'

/**
 * PRD 3119 — the DONE / FAILED card a macro background build's finish notice
 * renders as in an Epic's Discussion. scheduler.cjs's notifyOriginatingTab
 * (PRD 3116) appends a 'response' event with `notice: 'build-done' |
 * 'build-failed'` (+ `buildOutput` when the saved entry's meta was readable);
 * this card makes "the build finished" visible without the owner typing into
 * the session. Presentational: navigation is injected (`onOpenProjectHome`).
 * The text itself is main's — rendered as-is, never rewritten here.
 */

export type BuildOutput = NonNullable<PromptSessionEvent['buildOutput']>

export function BuildResultCard({
  event,
  cwd,
  epicId,
  onOpenProjectHome,
}: {
  event: PromptSessionEvent
  cwd: string
  epicId: string
  onOpenProjectHome: (cwd: string, buildOutput: BuildOutput | undefined) => void
}) {
  const done = event.notice === 'build-done'
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const textHtml = useMemo(() => renderChatMarkdown(event.text ?? ''), [event.text])
  const reportHtml = useMemo(() => (report ? renderChatMarkdown(report) : ''), [report])
  // The scheduler stores the builder's final result as an assistant transcript
  // turn tagged `prd-result:<slug>:<runId>` (scheduler.cjs), so a DONE card
  // with a slug can surface it on demand.
  const canShowReport = done && Boolean(event.prdSlug)

  const toggleReport = () => {
    if (!reportOpen && report === null && !loading && event.prdSlug) {
      const prefix = `prd-result:${event.prdSlug}:`
      setLoading(true)
      window.api.promptSessionTranscript
        .read(cwd, epicId)
        .then(({ turns }) => {
          const matches = turns.filter((t) => t.role === 'assistant' && t.eventId?.startsWith(prefix))
          const last = matches[matches.length - 1]
          setReport(last ? last.text : '')
        })
        .catch(() => setReport(''))
        .finally(() => setLoading(false))
    }
    setReportOpen((v) => !v)
  }

  return (
    <div
      data-testid="epic-build-result-card"
      data-notice={event.notice}
      role={done ? undefined : 'alert'}
      aria-label={`${done ? 'Build done' : 'Build failed'}: ${event.text ?? ''}`}
      className={`break-words rounded-lg border px-3 py-2 text-left text-[12px] ${
        done ? 'border-accent/40 bg-accent/10 text-fg' : 'border-red-500/40 bg-red-500/10 text-red-600'
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          data-testid="epic-build-result-marker"
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-white ${
            done ? 'bg-accent' : 'bg-red-500'
          }`}
        >
          {done ? 'DONE' : 'FAILED'}
        </span>
        {done && (
          <button
            type="button"
            data-testid="epic-build-result-open"
            onClick={() => onOpenProjectHome(cwd, event.buildOutput)}
            className="ml-auto rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white hover:brightness-95"
          >
            Open in Project Home
          </button>
        )}
      </div>
      <div
        data-testid="epic-build-result-text"
        className="prose-chat [&_*]:m-0"
        dangerouslySetInnerHTML={{ __html: textHtml }}
      />
      {canShowReport && (
        <div className="mt-1.5">
          <button
            type="button"
            data-testid="epic-build-result-report-toggle"
            aria-expanded={reportOpen}
            onClick={toggleReport}
            className="text-[11px] text-accent hover:underline"
          >
            {reportOpen ? "Hide the builder's report" : "Show the builder's report"}
          </button>
          {reportOpen && (
            <div data-testid="epic-build-result-report" className="mt-1 rounded-md border border-rule bg-bg px-2.5 py-1.5 text-[11.5px] text-fg-dim">
              {loading ? (
                'loading…'
              ) : report ? (
                <div className="prose-chat" dangerouslySetInnerHTML={{ __html: reportHtml }} />
              ) : (
                "The builder's report isn't in this session's transcript."
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
