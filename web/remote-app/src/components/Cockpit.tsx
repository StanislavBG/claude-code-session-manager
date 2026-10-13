import { useEffect } from 'react';
import { useStore, type Route } from '../store';
import type { RelaySocket } from '../ws';
import type { RemoteProject } from '../types';
import ProjectsScreen from './ProjectsScreen';
import SessionsScreen, { type OpenTarget } from './SessionsScreen';
import SessionScreen from './SessionScreen';

interface Props {
  socket: RelaySocket | null;
  deviceId: string;
}

const PROJECTS_ROUTE: Route = { view: 'projects' };

/**
 * Drill-down cockpit: Projects → a project's Sessions → one Session, driven by
 * `route` in the store. Each forward step pushes a history entry so the browser
 * back button (popstate) walks the route back up.
 */
export default function Cockpit({ socket, deviceId }: Props) {
  const wsConnected = useStore((s) => s.wsConnected);
  const awaitingDesktopConfirm = useStore((s) => s.awaitingDesktopConfirm);
  const route = useStore((s) => s.route);
  const refreshKey = useStore((s) => s.refreshKey);
  const goSessions = useStore((s) => s.goSessions);
  const goSession = useStore((s) => s.goSession);

  useEffect(() => {
    window.history.replaceState({ ...(window.history.state ?? {}), smRoute: useStore.getState().route }, '');
    const onPop = (e: PopStateEvent) => {
      const r = (e.state as { smRoute?: Route } | null)?.smRoute ?? PROJECTS_ROUTE;
      useStore.setState({ route: r });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const push = () => window.history.pushState({ smRoute: useStore.getState().route }, '');
  const back = () => window.history.back();

  const openProject = (p: RemoteProject) => { goSessions(p.cwd, p.title); push(); };
  const openTarget = (cwd: string, t: OpenTarget) => {
    goSession(cwd, t.kind === 'main' ? t.title : t.session.title, t);
    push();
  };

  const title = route.view === 'projects' ? 'Session Manager' : route.title;

  let body;
  if (route.view === 'projects') {
    body = awaitingDesktopConfirm ? (
      <div className="flex-1 flex items-center justify-center text-ink-mute text-sm px-6 text-center font-serif italic">
        Waiting for you to confirm the 6-digit code on your computer (Settings → Phone remote)…
      </div>
    ) : (
      <ProjectsScreen socket={socket} deviceId={deviceId} refreshKey={refreshKey} onOpen={openProject} />
    );
  } else if (route.view === 'sessions') {
    body = (
      <SessionsScreen
        socket={socket}
        deviceId={deviceId}
        cwd={route.cwd}
        refreshKey={refreshKey}
        onBack={back}
        onOpen={(t) => openTarget(route.cwd, t)}
      />
    );
  } else {
    body = (
      <SessionScreen socket={socket} deviceId={deviceId} projectCwd={route.cwd} target={route.target} onBack={back} />
    );
  }

  return (
    <div className="flex flex-col h-dvh text-ink">
      <header className="flex items-center gap-3 px-3 pt-[max(0.25rem,env(safe-area-inset-top))] h-[calc(3rem+env(safe-area-inset-top))] border-b border-edge bg-paper flex-shrink-0">
        <span className="flex-1 font-serif text-lg font-semibold truncate">{title}</span>
        <span className="inline-flex items-center gap-1.5 text-xs font-mono text-ink-soft" aria-live="polite">
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-sage rm-pulse' : 'bg-ink-mute'}`} />
          {wsConnected ? 'live' : 'offline'}
        </span>
      </header>
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">{body}</main>
    </div>
  );
}
