import { useStore } from '../store';
import Header from './Header';
import TerminalPane from './TerminalPane';
import SchedulerPane from './SchedulerPane';
import SessionsPane from './SessionsPane';
import type { RelaySocket } from '../ws';

type Tab = 'terminal' | 'scheduler' | 'sessions';

interface Props {
  deviceId: string;
  tab: Tab;
  socket: RelaySocket | null;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'terminal', label: 'Terminal' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'sessions', label: 'Sessions' },
];

export default function DeviceView({ deviceId, tab, socket }: Props) {
  const { devices, setScreen } = useStore();
  const device = devices.find((d) => d.deviceId === deviceId);

  const setTab = (t: Tab) =>
    setScreen({ kind: 'device', deviceId, tab: t });

  const isOffline = device ? !device.isOnline : true;

  return (
    <div className="flex flex-col h-dvh bg-bg" data-testid="device-view">
      <Header
        title={deviceId.slice(0, 8) + '…'}
        onBack={() => setScreen({ kind: 'devices' })}
      />

      {/* Offline banner */}
      {isOffline && (
        <div
          className="bg-amber-900/50 border-b border-amber-700 px-4 py-2 text-amber-300 text-xs text-center"
          role="status"
          aria-live="polite"
          data-testid="offline-banner"
        >
          Device is offline — commands unavailable
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'terminal' && (
          <TerminalPane deviceId={deviceId} socket={socket} disabled={isOffline} />
        )}
        {tab === 'scheduler' && (
          <SchedulerPane deviceId={deviceId} socket={socket} disabled={isOffline} />
        )}
        {tab === 'sessions' && (
          <SessionsPane deviceId={deviceId} socket={socket} disabled={isOffline} />
        )}
      </div>

      {/* Bottom tab bar */}
      <nav
        className="flex border-t border-slate-700 bg-surface safe-bottom"
        aria-label="Device control tabs"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`
              flex-1 min-h-touch flex flex-col items-center justify-center gap-0.5
              text-xs font-medium transition-colors
              ${tab === id ? 'text-indigo-400' : 'text-slate-400 active:text-slate-100'}
            `}
            aria-selected={tab === id}
            aria-label={label}
            role="tab"
          >
            <TabIcon id={id} active={tab === id} />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function TabIcon({ id, active }: { id: Tab; active: boolean }) {
  const cls = `w-5 h-5 ${active ? 'text-indigo-400' : 'text-slate-500'}`;
  if (id === 'terminal') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </svg>
    );
  }
  if (id === 'scheduler') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
