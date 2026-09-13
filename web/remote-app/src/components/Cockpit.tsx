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
    <div className="flex flex-col h-dvh text-ink">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-3 pt-[max(0.25rem,env(safe-area-inset-top))] h-[calc(3rem+env(safe-area-inset-top))] border-b border-edge bg-paper flex-shrink-0">
        <button
          onClick={() => setNavOpen(!navOpen)}
          className="min-h-touch min-w-touch flex items-center justify-center text-ink active:text-accent"
          aria-label="Toggle sessions"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <span className="flex-1 font-serif text-lg font-semibold truncate">
          {selected?.title ?? 'Session Manager'}
        </span>
        <span
          className="inline-flex items-center gap-1.5 text-xs font-mono text-ink-soft"
          aria-live="polite"
        >
          <span className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-sage rm-pulse' : 'bg-ink-mute'}`} />
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
            <div className="flex-1 flex items-center justify-center text-ink-mute text-sm px-6 text-center font-serif italic">
              {sessions.length ? 'Select a session from the menu.' : 'No active sessions on this device yet.'}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
