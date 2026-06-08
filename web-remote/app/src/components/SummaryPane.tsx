import { useState } from 'react';
import { useStore } from '../store';

/** Pane 2: the mobile summary of the last assistant turn; tap to expand to raw. */
export default function SummaryPane({ tabId }: { tabId: string }) {
  const summary = useStore((s) => s.summaryByTab[tabId]);
  const [expanded, setExpanded] = useState(false);

  if (!summary) {
    return (
      <section className="flex-1 overflow-y-auto px-4 py-4 text-sm text-slate-500" data-testid="summary-pane">
        Waiting for the next model message…
      </section>
    );
  }

  const isRaw = summary.model === 'raw';
  return (
    <section className="flex-1 overflow-y-auto px-4 py-4" data-testid="summary-pane">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">
          {isRaw ? 'Last message' : 'Summary'}
        </span>
        {summary.degraded === 'no_api_key' && (
          <span className="text-xs text-amber-400" title="Set ANTHROPIC_API_KEY on the desktop app for summaries">
            · set API key for summaries
          </span>
        )}
        {summary.degraded === 'api_error' && (
          <span className="text-xs text-amber-400">· summary failed, showing raw</span>
        )}
      </div>
      <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-slate-100">
        {summary.summary}
      </p>
      {!isRaw && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 text-xs text-indigo-400 active:text-indigo-200 min-h-touch"
        >
          {expanded ? 'Hide raw message' : 'Show raw message'}
        </button>
      )}
      {expanded && (
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-400 border-t border-slate-800 pt-2">
          {/* The agent only pushes the summary; raw is shown when degraded. For
              full raw, the desktop transcript remains the source of truth. */}
          Open the desktop app for the full transcript.
        </p>
      )}
    </section>
  );
}
