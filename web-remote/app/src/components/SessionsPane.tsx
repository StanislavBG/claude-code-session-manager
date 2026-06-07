import { useState, useEffect, useCallback } from 'react';
import type { RelaySocket } from '../ws';
import type { SessionRecord } from '../types';

interface Props {
  deviceId: string;
  socket: RelaySocket | null;
  disabled: boolean;
}

export default function SessionsPane({ deviceId, socket, disabled }: Props) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!socket || disabled) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await socket.sendCommand('cmd:sessions:load', deviceId);
      const p = resp.payload as { sessions?: SessionRecord[] } | undefined;
      setSessions(p?.sessions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, [socket, deviceId, disabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (disabled) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        Device offline
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-bg">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700 bg-surface flex-shrink-0">
        <span className="flex-1 text-sm font-medium text-slate-300">Sessions</span>
        <button
          onClick={refresh}
          className="min-h-touch min-w-touch flex items-center text-slate-400 active:text-slate-100 text-xs"
          aria-label="Refresh sessions"
          disabled={loading}
        >
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="px-4 py-2 text-red-400 text-xs" role="alert">{error}</div>
        )}

        {sessions.length === 0 && !loading && !error && (
          <div className="flex items-center justify-center h-32 text-slate-500 text-sm">
            No active sessions
          </div>
        )}

        {sessions.map((s) => (
          <div
            key={s.tabId}
            className="px-4 py-3 border-b border-slate-800 flex flex-col gap-1"
            aria-label={`Session ${s.tabId}`}
          >
            <div className="text-sm font-mono text-slate-300 truncate">{s.tabId.slice(0, 12)}…</div>
            {s.cwd && (
              <div className="text-xs text-slate-500 truncate">{s.cwd}</div>
            )}
            {s.startedAt && (
              <div className="text-xs text-slate-600">
                {new Date(s.startedAt).toLocaleTimeString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
