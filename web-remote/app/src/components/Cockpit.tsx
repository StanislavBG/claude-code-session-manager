import { useStore } from '../store';
import type { RelaySocket } from '../ws';
import SessionNav from './SessionNav';
import StatePane from './StatePane';
import SummaryPane from './SummaryPane';
import MicPane from './MicPane';

interface Props {
  socket: RelaySocket | null;
  deviceId: string;
}

/**
 * Session cockpit: collapsible left-nav (sessions) + 3-pane main
 * (state animation / mobile summary / mic input). Mobile-first single column;
 * the left-nav is a slide-over drawer on small screens.
 */
export default function Cockpit({ socket, deviceId }: Props) {
  const { wsConnected, navOpen, setNavOpen, selectedTabId, sessions } = useStore();
  const selected = sessions.find((s) => s.tabId === selectedTabId) ?? null;

  return (
    <div className="flex flex-col h-dvh bg-bg text-slate-100">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-3 h-12 border-b border-slate-800 bg-surface flex-shrink-0">
        <button
          onClick={() => setNavOpen(!navOpen)}
          className="min-h-touch min-w-touch flex items-center justify-center text-slate-300 active:text-white"
          aria-label="Toggle sessions"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <span className="flex-1 text-sm font-semibold truncate">
          {selected?.title ?? 'Session Manager'}
        </span>
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${wsConnected ? 'text-emerald-400' : 'text-slate-500'}`}
          aria-live="polite"
        >
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
          {wsConnected ? 'live' : 'offline'}
        </span>
      </header>

      <div className="flex flex-1 overflow-hidden relative">
        {/* Left-nav drawer */}
        <SessionNav />

        {/* Main: 3-pane split */}
        <main className="flex-1 flex flex-col min-w-0">
          {selectedTabId ? (
            <>
              <StatePane tabId={selectedTabId} />
              <SummaryPane tabId={selectedTabId} />
              <MicPane socket={socket} deviceId={deviceId} tabId={selectedTabId} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-sm px-6 text-center">
              {sessions.length ? 'Select a session from the menu.' : 'No active sessions on this device yet.'}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
