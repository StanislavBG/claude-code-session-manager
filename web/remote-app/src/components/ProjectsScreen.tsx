import { useCallback, useEffect, useState } from 'react';
import { listProjects } from '../remoteApi';
import type { RemoteProject } from '../types';
import type { RelaySocket } from '../ws';
import DesktopClientsPanel from './DesktopClientsPanel';

type State =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; projects: RemoteProject[] };

/** Short last path segment for a cwd, e.g. /home/me/Projects/foo → foo */
function basename(cwd: string): string {
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

/** First drill-down screen: projects open in Session Manager on the paired computer. */
export default function ProjectsScreen({
  socket,
  deviceId,
  refreshKey,
  onOpen,
}: {
  socket: RelaySocket | null;
  deviceId: string;
  refreshKey: number;
  onOpen: (p: RemoteProject) => void;
}) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!socket) return;
    let live = true;
    setState({ status: 'loading' });
    listProjects(socket, deviceId)
      .then((r) => live && setState({ status: 'ready', projects: r?.projects ?? [] }))
      .catch((e) =>
        live && setState({ status: 'error', error: e?.message || 'could not load projects' }),
      );
    return () => {
      live = false;
    };
  }, [socket, deviceId, refreshKey, attempt]);

  return (
    <div className="flex-1 overflow-y-auto rm-scroll px-3 py-3">
      <div className="px-1 pb-2 text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute">
        Projects
      </div>
      {state.status === 'loading' && (
        <div className="px-1 py-5 text-sm text-ink-mute font-serif italic" role="status">
          Loading projects…
        </div>
      )}
      {state.status === 'error' && (
        <div className="px-1 py-4 flex flex-col gap-3" role="alert">
          <div className="text-sm text-ink">{state.error}</div>
          <button
            data-track="projects-retry"
            onClick={retry}
            className="self-start min-h-touch px-4 rounded-2xl border border-edge bg-card text-sm font-semibold text-accent"
          >
            Retry
          </button>
        </div>
      )}
      {state.status === 'ready' && state.projects.length === 0 && (
        <div className="px-1 py-5 text-sm text-ink-mute font-serif italic">
          No projects open in Session Manager on your computer.
        </div>
      )}
      {state.status === 'ready' && state.projects.length > 0 && (
        <div className="flex flex-col gap-2">
          {state.projects.map((p, i) => (
            <button
              key={p.cwd}
              data-testid="project-row"
              data-track="projects-open"
              data-track-redact=""
              onClick={() => onOpen(p)}
              className="rm-in w-full flex flex-col gap-0.5 px-3.5 py-3 text-left rounded-2xl border border-edge bg-card min-h-touch transition-colors active:bg-panel"
              style={{ animationDelay: `${i * 45}ms` }}
            >
              <div className="text-[15px] font-semibold text-ink truncate">{p.title}</div>
              <div className="font-mono text-[11.5px] text-ink-mute truncate">{basename(p.cwd)}</div>
              <div className="text-xs text-ink-mute">
                {p.counts.active} active · {p.counts.proposed} proposed
              </div>
            </button>
          ))}
        </div>
      )}
      <DesktopClientsPanel />
    </div>
  );
}
