import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjectSessions } from '../remoteApi';
import type { ProjectSessionsResponse, RemoteSession } from '../types';
import type { RelaySocket } from '../ws';
import NewSessionSheet from './NewSessionSheet';

export type OpenTarget =
  | { kind: 'main'; mainTabId: string; title: string }
  | { kind: 'epic'; session: RemoteSession };

type State =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: ProjectSessionsResponse };

const SECTIONS = [
  { status: 'active', label: 'Active' },
  { status: 'proposed', label: 'Proposed' },
  { status: 'completed', label: 'Completed' },
] as const;

const PILL: Record<string, string> = {
  active: 'text-accent border-accent/40 bg-accent/10',
  proposed: 'text-ink-mute border-edge bg-panel',
  completed: 'text-ink-mute border-edge bg-panel',
};

/** Lifecycle status pill (proposed / active / completed) — distinct from the live StatePill. */
function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`text-[10.5px] font-bold uppercase tracking-[0.3px] px-2 py-0.5 rounded-full border ${PILL[status] ?? PILL.proposed}`}
    >
      {status}
    </span>
  );
}

/** Short last path segment for a cwd, e.g. /home/me/Projects/foo → foo */
function basename(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

/** Second drill-down screen: one project's Main session and Epics, grouped by lifecycle. */
export default function SessionsScreen({
  socket,
  deviceId,
  cwd,
  refreshKey,
  onBack,
  onOpen,
}: {
  socket: RelaySocket | null;
  deviceId: string;
  cwd: string;
  refreshKey: number;
  onBack: () => void;
  onOpen: (t: OpenTarget) => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [sheet, setSheet] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!socket) return;
    let live = true;
    setState({ status: 'loading' });
    listProjectSessions(socket, deviceId, cwd)
      .then((data) => live && setState({ status: 'ready', data }))
      .catch((e) =>
        live && setState({ status: 'error', error: e?.message || 'could not load sessions' }),
      );
    return () => {
      live = false;
    };
  }, [socket, deviceId, cwd, refreshKey, attempt]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const onStarted = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(retry, 1500);
  }, [retry]);

  const project = state.status === 'ready' ? state.data.project : null;
  const title = project?.title || basename(cwd);
  const sessions = state.status === 'ready' ? (state.data.sessions ?? []) : [];

  return (
    <div className="flex-1 overflow-y-auto rm-scroll px-3 py-3">
      <div className="flex items-center gap-2 pb-2">
        <button
          onClick={onBack}
          data-track="sessions-back"
          className="min-h-touch px-2 text-sm font-semibold text-accent"
          aria-label="Back"
        >
          ‹ Back
        </button>
        <div className="flex-1 min-w-0 text-[15px] font-semibold text-ink truncate">{title}</div>
        <button
          onClick={() => setSheet(true)}
          data-track="sessions-new"
          className="text-xs font-semibold text-accent min-h-touch px-1"
          aria-label={`New session in ${title}`}
        >
          + New session
        </button>
      </div>
      {state.status === 'loading' && (
        <div className="px-1 py-5 text-sm text-ink-mute font-serif italic" role="status">
          Loading sessions…
        </div>
      )}
      {state.status === 'error' && (
        <div className="px-1 py-4 flex flex-col gap-3" role="alert">
          <div className="text-sm text-ink">{state.error}</div>
          <button
            onClick={retry}
            data-track="sessions-retry"
            className="self-start min-h-touch px-4 rounded-2xl border border-edge bg-card text-sm font-semibold text-accent"
          >
            Retry
          </button>
        </div>
      )}
      {state.status === 'ready' && (
        <div className="flex flex-col gap-2">
          {project && (
            <button
              data-testid="main-session-row"
              data-track="sessions-open-main"
              data-track-redact=""
              onClick={() => onOpen({ kind: 'main', mainTabId: project.mainTabId, title })}
              className="w-full flex items-center gap-3 px-3.5 py-3 text-left rounded-2xl border border-edge bg-card min-h-touch active:bg-panel"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[15px] font-semibold text-ink truncate">Main</div>
                <div className="font-mono text-[11.5px] text-ink-mute truncate">{title}</div>
              </div>
            </button>
          )}
          {sessions.length === 0 && (
            <div className="px-1 py-5 text-sm text-ink-mute font-serif italic">
              No sessions in this project yet.
            </div>
          )}
          {SECTIONS.map(({ status, label }) => {
            const rows = sessions.filter((s) => s.status === status);
            if (rows.length === 0) return null;
            return (
              <section key={status} aria-label={label} className="flex flex-col gap-2">
                <div className="px-1 pt-2 text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute">
                  {label}
                </div>
                {rows.map((s) => (
                  <button
                    key={s.epicId}
                    data-testid="session-row"
                    data-track="sessions-open-epic"
                    data-track-redact=""
                    onClick={() => onOpen({ kind: 'epic', session: s })}
                    className={`w-full flex items-center gap-3 px-3.5 py-3 text-left rounded-2xl border border-edge bg-card min-h-touch active:bg-panel ${status === 'completed' ? 'opacity-60' : ''}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold text-ink truncate">{s.title}</div>
                      <div className="font-mono text-[11.5px] text-ink-mute truncate">
                        {[s.tag, s.agentType].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <StatusPill status={s.status} />
                  </button>
                ))}
              </section>
            );
          })}
        </div>
      )}
      {sheet && (
        <NewSessionSheet
          socket={socket}
          deviceId={deviceId}
          cwd={cwd}
          project={title}
          onClose={() => setSheet(false)}
          onStarted={onStarted}
        />
      )}
    </div>
  );
}
