import { useState } from 'react';
import { useStore } from '../store';

/** Pane 2: the mobile summary of the last assistant turn; tap to expand to raw. */
export default function SummaryPane({ tabId }: { tabId: string }) {
  const summary = useStore((s) => s.summaryByTab[tabId]);
  const [expanded, setExpanded] = useState(false);

  if (!summary) {
    return (
      <section className="flex-1 overflow-y-auto rm-scroll px-5 py-5 text-sm text-ink-mute font-serif italic" data-testid="summary-pane">
        Waiting for the next model message…
      </section>
    );
  }

  const isRaw = summary.model === 'raw';
  return (
    <section className="flex-1 overflow-y-auto rm-scroll px-5 py-5" data-testid="summary-pane">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute">
          {isRaw ? 'Last message' : 'Summary'}
        </span>
        {summary.degraded === 'no_api_key' && (
          <span className="text-xs text-butter" title="Set ANTHROPIC_API_KEY on the desktop app for summaries">
            · set API key for summaries
          </span>
        )}
        {summary.degraded === 'api_error' && (
          <span className="text-xs text-butter">· summary failed, showing raw</span>
        )}
      </div>
      <p className="text-[15.5px] leading-relaxed whitespace-pre-wrap text-ink">
        {summary.summary}
      </p>
      {!isRaw && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-3.5 text-xs font-semibold text-accent active:opacity-70 min-h-touch"
        >
          {expanded ? 'Hide raw message' : 'Show raw message'}
        </button>
      )}
      {expanded && (
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-ink-soft border-t border-edge pt-3 font-serif italic">
          {/* The agent only pushes the summary; raw is shown when degraded. For
              full raw, the desktop transcript remains the source of truth. */}
          Open the desktop app for the full transcript.
        </p>
      )}
    </section>
  );
}
