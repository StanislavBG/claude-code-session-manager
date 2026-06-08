import { useEffect, useRef } from 'react';
import {
  ClerkProvider, SignedIn, SignedOut, SignIn, useAuth,
} from '@clerk/clerk-react';
import { useStore } from './store';
import { getMe, getDevices, setTokenGetter } from './api';
import { RelaySocket } from './ws';
import Cockpit from './components/Cockpit';
import ConnectScreen from './components/ConnectScreen';
import type { Envelope, SessionMeta, SessionSummary, SessionState } from './types';

// Same Clerk instance as bilko.run (clerk.bilko.run) so the static sibling shares
// the host session. Publishable keys are public; overridable at build time.
const CLERK_KEY =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ||
  'pk_live_Y2xlcmsuYmlsa28ucnVuJA';

export default function App() {
  return (
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl="/projects/session-manager/">
      <SignedOut>
        <div className="flex items-center justify-center min-h-dvh bg-bg p-4">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <AppInner />
      </SignedIn>
    </ClerkProvider>
  );
}

function AppInner() {
  const { getToken } = useAuth();
  const {
    activeDeviceId, selectedTabId, sessions,
    setMe, setDevices, setDeviceOnline, setActiveDevice,
    setWsConnected, setSessions, setTabState, setTabSummary, reset,
  } = useStore();
  const socketRef = useRef<RelaySocket | null>(null);

  // Wire Clerk token into the relay API client, then bootstrap.
  useEffect(() => {
    setTokenGetter(() => getToken());
    getMe()
      .then((user) => {
        setMe(user);
        if (user) return getDevices().then((r) => setDevices(r.devices));
      })
      .catch(console.error);
  }, [getToken, setMe, setDevices]);

  // Connect the relay socket once.
  useEffect(() => {
    const socket = new RelaySocket((connected) => setWsConnected(connected));
    socketRef.current = socket;
    socket.connect().catch(console.error);

    const offStatus = socket.on('event:device:status', (m: Envelope) => {
      if (m.deviceId && m.status) {
        const online = m.status === 'connected';
        setDeviceOnline(m.deviceId, online);
        if (online) setActiveDevice(m.deviceId);
      }
    });
    const offList = socket.on('event:session:list', (m: Envelope) => {
      const p = m.payload as { sessions?: SessionMeta[] } | undefined;
      if (p?.sessions) setSessions(p.sessions);
    });
    const offState = socket.on('event:session:state', (m: Envelope) => {
      const p = m.payload as { tabId?: string; state?: SessionState } | undefined;
      if (p?.tabId && p.state) setTabState(p.tabId, p.state);
    });
    const offSummary = socket.on('event:session:summary', (m: Envelope) => {
      const p = m.payload as SessionSummary | undefined;
      if (p?.tabId) setTabSummary(p);
    });

    return () => {
      offStatus(); offList(); offState(); offSummary();
      socket.destroy();
      socketRef.current = null;
      reset();
    };
  }, [setWsConnected, setDeviceOnline, setActiveDevice, setSessions, setTabState, setTabSummary, reset]);

  // Subscribe to the selected session's live state + summary; unsubscribe on change.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !activeDeviceId || !selectedTabId) return;
    const sess = sessions.find((s) => s.tabId === selectedTabId);
    if (!sess?.cwd) return;
    socket.sendCommand('cmd:session:subscribe', activeDeviceId, { tabId: selectedTabId, cwd: sess.cwd })
      .catch(() => {});
    return () => {
      socket.sendCommand('cmd:session:unsubscribe', activeDeviceId, { tabId: selectedTabId }).catch(() => {});
    };
  }, [activeDeviceId, selectedTabId, sessions]);

  const device = useStore((s) => s.devices.find((d) => d.deviceId === s.activeDeviceId));
  const online = !!device?.isOnline;

  if (online) {
    return <Cockpit socket={socketRef.current} deviceId={activeDeviceId!} />;
  }
  return <ConnectScreen socket={socketRef.current} />;
}
