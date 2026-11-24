import type { PromptSessionEvent } from '../../state/promptSessions'
import { revealInFileExplorer } from '../../lib/revealInFileExplorer'
import { formatBytes } from '../../lib/formatBytes'

/**
 * The card an 'artifact-ready' notice renders as in an Epic's Discussion.
 * lib/epic/artifactNotice.cjs appends ONE 'response' event per publish call /
 * ingest batch with `notice: 'artifact-ready'`, up to 20 `artifacts` rows (path
 * relative to the project cwd) and `moreCount` for the rest. Each row reveals
 * its file in the app's File Explorer. The text itself is main's — as-is.
 */

export type ArtifactRow = NonNullable<PromptSessionEvent['artifacts']>[number]

export function ArtifactReadyCard({ event, cwd }: { event: PromptSessionEvent; cwd: string }) {
  const rows = event.artifacts ?? []
  const more = event.moreCount && event.moreCount > 0 ? event.moreCount : 0
  // Join with '/' only — relativeSegments (revealInFileExplorer.ts) normalizes.
  const reveal = (row: ArtifactRow) => revealInFileExplorer(`${cwd}/${row.path}`)

  return (
    <div
      data-testid="artifact-ready-card"
      data-notice={event.notice}
      aria-label={event.text ?? 'Artifacts ready'}
      className="break-words rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-left text-[12px] text-fg"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-white">
          ARTIFACT
        </span>
        <span data-testid="artifact-ready-text">{event.text ?? ''}</span>
      </div>
      <ul className="m-0 list-none p-0">
        {rows.map((row, i) => (
          <li key={`${row.path}:${i}`}>
            <button
              type="button"
              data-testid="artifact-ready-row"
              title={`Reveal ${row.path} in the File Explorer`}
              onClick={() => reveal(row)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-0.5 text-left hover:bg-accent/15"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-fg-dim">{row.kind}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-fg-dim">{formatBytes(row.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <div data-testid="artifact-ready-more" className="mt-0.5 px-1.5 text-[11px] text-fg-dim">
          +{more} more
        </div>
      )}
    </div>
  )
}
