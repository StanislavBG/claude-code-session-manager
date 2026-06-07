import { useState, useEffect, useCallback } from 'react';
import type { RelaySocket } from '../ws';
import type { SchedulerState, PrdMeta } from '../types';

interface Props {
  deviceId: string;
  socket: RelaySocket | null;
  disabled: boolean;
}

export default function SchedulerPane({ deviceId, socket, disabled }: Props) {
  const [state, setState] = useState<SchedulerState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPrd, setSelectedPrd] = useState<string | null>(null);
  const [prdContent, setPrdContent] = useState<string | null>(null);
  const [prdLoading, setPrdLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!socket || disabled) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await socket.sendCommand('cmd:schedule:state', deviceId);
      const p = resp.payload as SchedulerState | undefined;
      if (p) setState(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load scheduler');
    } finally {
      setLoading(false);
    }
  }, [socket, deviceId, disabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runNow = useCallback(async () => {
    if (!socket || disabled) return;
    if (!window.confirm('Trigger scheduler run now?')) return;
    try {
      await socket.sendCommand('cmd:schedule:run-now', deviceId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to trigger run');
    }
  }, [socket, deviceId, disabled, refresh]);

  const resetJob = useCallback(
    async (slug: string) => {
      if (!socket || disabled) return;
      if (!window.confirm(`Reset job "${slug}"?`)) return;
      try {
        await socket.sendCommand('cmd:schedule:reset-job', deviceId, { slug });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to reset job');
      }
    },
    [socket, deviceId, disabled, refresh],
  );

  const loadPrd = useCallback(
    async (slug: string) => {
      if (!socket || disabled) return;
      setSelectedPrd(slug);
      setPrdLoading(true);
      setPrdContent(null);
      try {
        const resp = await socket.sendCommand('cmd:schedule:read-prd', deviceId, { slug });
        const p = resp.payload as { content?: string } | undefined;
        setPrdContent(p?.content ?? '');
      } catch (e) {
        setPrdContent(`Error: ${e instanceof Error ? e.message : 'unknown'}`);
      } finally {
        setPrdLoading(false);
      }
    },
    [socket, deviceId, disabled],
  );

  if (disabled) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        Device offline
      </div>
    );
  }

  if (selectedPrd !== null) {
    return (
      <div className="flex flex-col h-full bg-bg">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-700 bg-surface flex-shrink-0">
          <button
            onClick={() => { setSelectedPrd(null); setPrdContent(null); }}
            className="min-h-touch min-w-touch flex items-center text-slate-400 active:text-slate-100 text-sm"
            aria-label="Back to scheduler"
          >
            ← Back
          </button>
          <span className="flex-1 text-sm font-medium text-slate-300 truncate">{selectedPrd}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {prdLoading ? (
            <p className="text-slate-400 text-sm">Loading…</p>
          ) : (
            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono break-words">
              {prdContent}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg overflow-y-auto">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 bg-surface flex-shrink-0">
        <span className="flex-1 text-sm font-medium text-slate-300">Scheduler</span>
        <button
          onClick={refresh}
          className="min-h-touch min-w-touch flex items-center text-slate-400 active:text-slate-100 text-xs"
          aria-label="Refresh scheduler state"
          disabled={loading}
        >
          {loading ? '…' : '↻'}
        </button>
        <button
          onClick={runNow}
          className="min-h-touch px-3 rounded-lg bg-indigo-600 text-white text-xs font-medium active:bg-indigo-700"
          aria-label="Run scheduler now"
          disabled={loading || disabled}
        >
          Run Now
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-red-400 text-xs" role="alert">{error}</div>
      )}

      {state && (
        <div className="flex flex-col divide-y divide-slate-800">
          {/* Status row */}
          <div className="px-4 py-3 flex items-center gap-3">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${state.running ? 'bg-green-500' : 'bg-slate-500'}`}
              aria-hidden="true"
            />
            <span className="text-sm text-slate-300">
              {state.running ? 'Running' : 'Idle'} · {state.mode}
            </span>
          </div>

          {/* Active job */}
          {state.activeJob && (
            <div className="px-4 py-3">
              <div className="text-xs text-slate-500 mb-1">Active job</div>
              <PrdRow
                prd={state.activeJob}
                active
                onView={() => loadPrd(state.activeJob!.slug)}
                onReset={() => resetJob(state.activeJob!.slug)}
              />
            </div>
          )}

          {/* Queue */}
          {state.queue.length > 0 && (
            <div className="px-4 py-3 flex flex-col gap-2">
              <div className="text-xs text-slate-500 mb-1">Queue ({state.queue.length})</div>
              {state.queue.map((prd) => (
                <PrdRow
                  key={prd.slug}
                  prd={prd}
                  onView={() => loadPrd(prd.slug)}
                  onReset={() => resetJob(prd.slug)}
                />
              ))}
            </div>
          )}

          {state.queue.length === 0 && !state.activeJob && (
            <div className="px-4 py-6 text-center text-slate-500 text-sm">
              Queue is empty
            </div>
          )}
        </div>
      )}

      {!state && !loading && !error && (
        <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
          Tap refresh to load
        </div>
      )}
    </div>
  );
}

interface PrdRowProps {
  prd: PrdMeta;
  active?: boolean;
  onView: () => void;
  onReset: () => void;
}

function PrdRow({ prd, active, onView, onReset }: PrdRowProps) {
  return (
    <div className={`flex items-center gap-2 rounded-lg p-3 ${active ? 'bg-indigo-900/30 border border-indigo-700/50' : 'bg-surface'}`}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-200 truncate">{prd.title ?? prd.slug}</div>
        {prd.status && (
          <div className="text-xs text-slate-500">{prd.status}</div>
        )}
      </div>
      <button
        onClick={onView}
        className="min-h-touch px-2 text-xs text-indigo-400 active:text-indigo-300 flex-shrink-0"
        aria-label={`View PRD ${prd.slug}`}
      >
        View
      </button>
      <button
        onClick={onReset}
        className="min-h-touch px-2 text-xs text-amber-400 active:text-amber-300 flex-shrink-0"
        aria-label={`Reset job ${prd.slug}`}
      >
        Reset
      </button>
    </div>
  );
}
