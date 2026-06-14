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
        <div className="flex items-center justify-center min-h-dvh p-4">
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <AppInner />
      </SignedIn>
    </ClerkProvider>
  );
}

const PIN_PREFIX = 'sm-e2e-pin-v1-';

function AppInner() {
  const { getToken } = useAuth();
  const {
    activeDeviceId, selectedTabId, sessions,
    setMe, setDevices, setDeviceOnline, setActiveDevice,
    setWsConnected, setSessions, setTabState, setTabSummary, reset,
    setPendingSas, addKeyMismatch,
  } = useStore();
  const socketRef = useRef<RelaySocket | null>(null);

  // Wire Clerk token into the relay API client, then bootstrap.
  useEffect(() => {
    setTokenGetter(() => getToken());
    getMe()
      .then((user) => {
        setMe(user);
        if (!user) return;
        return getDevices().then((r) => {
          // TOFU key pinning: pin devicePubKey at first encounter per deviceId.
          // On subsequent loads, a changed key for the same deviceId raises a
          // visible alarm and the mismatched device is excluded from E2E.
          const mismatchIds: string[] = [];
          const safeDevices = r.devices.map((d) => {
            if (!d.devicePubKey) return d;
            const storageKey = `${PIN_PREFIX}${d.deviceId}`;
            const pinned = localStorage.getItem(storageKey);
            if (!pinned) {
              localStorage.setItem(storageKey, d.devicePubKey);
              return d;
            }
            if (pinned !== d.devicePubKey) {
              // Relay-served key diverged from pinned value — possible substitution.
              mismatchIds.push(d.deviceId);
              return { ...d, devicePubKey: undefined }; // exclude from E2E
            }
            return d;
          });
          setDevices(safeDevices);
          mismatchIds.forEach(addKeyMismatch);
        });
      })
      .catch(console.error);
  }, [getToken, setMe, setDevices, addKeyMismatch]);

  // Connect the relay socket once.
  useEffect(() => {
    const socket = new RelaySocket((connected) => setWsConnected(connected));
    socketRef.current = socket;
    socket.connect().catch(console.error);

    const offStatus = socket.on('event:device:status', (m: Envelope) => {
      if (m.deviceId && m.status) {
        const online = m.status === 'connected';
        setDeviceOnline(m.deviceId, online);
        if (online) {
          setActiveDevice(m.deviceId);
          // Negotiate E2E (P-256 ECDH → AES-256-GCM) so the relay only ever sees
          // ciphertext. Idempotent — initiateE2E no-ops if the session exists.
          const dev = useStore.getState().devices.find((d) => d.deviceId === m.deviceId);
          if (dev?.devicePubKey) socket.initiateE2E(m.deviceId, dev.devicePubKey).catch(console.warn);
        }
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
    // Internal event: SAS computed after e2e:ready; show to user for manual comparison.
    const offSas = socket.on('sas:pending', (m: Envelope) => {
      const p = m.payload as { sas?: string } | undefined;
      if (m.deviceId && p?.sas) setPendingSas({ deviceId: m.deviceId, sas: p.sas });
    });

    return () => {
      offStatus(); offList(); offState(); offSummary(); offSas();
      socket.destroy();
      socketRef.current = null;
      reset();
    };
  }, [setWsConnected, setDeviceOnline, setActiveDevice, setSessions, setTabState, setTabSummary, reset, setPendingSas]);

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
  const pendingSas = useStore((s) => s.pendingSas);
  const keyMismatchDeviceIds = useStore((s) => s.keyMismatchDeviceIds);
  const clearPendingSas = useStore((s) => s.clearPendingSas);

  // Fallback: negotiate E2E for the active device once its pubKey is known —
  // covers the case where event:device:status arrived before getDevices resolved.
  // initiateE2E is idempotent (no-ops if a session is already established).
  useEffect(() => {
    const socket = socketRef.current;
    if (socket && online && device?.devicePubKey && device.deviceId) {
      socket.initiateE2E(device.deviceId, device.devicePubKey).catch(() => {});
    }
  }, [online, device?.deviceId, device?.devicePubKey]);

  const banners = (
    <>
      {keyMismatchDeviceIds.length > 0 && (
        <div className="fixed top-0 inset-x-0 z-50 safe-top bg-[#f8e8e0] border-b border-[#eccdbe] px-4 py-3 text-sm text-[#9a3f1f]">
          <strong className="font-semibold">Key substitution detected.</strong> The desktop public key for{' '}
          {keyMismatchDeviceIds.length === 1
            ? `device ${keyMismatchDeviceIds[0].slice(0, 8)}…`
            : `${keyMismatchDeviceIds.length} device(s)`}{' '}
          does not match the pinned value. This may indicate a relay MITM. Revoke and re-pair.
        </div>
      )}
      {pendingSas && (
        <div className="fixed bottom-0 inset-x-0 z-50 safe-bottom bg-paper border-t border-edge px-4 py-5 shadow-[0_-10px_40px_rgba(120,80,40,0.18)]">
          <div className="max-w-sm mx-auto text-center">
            <p className="font-serif text-xl font-semibold text-ink mb-1">Verify E2E session</p>
            <p className="text-ink-mute mb-3 text-xs">
              Confirm the desktop (Remote tab) shows the same 6-digit code:
            </p>
            <div className="text-3xl font-mono tracking-[0.3em] text-accent mb-4 select-all">
              {pendingSas.sas}
            </div>
            <button
              onClick={clearPendingSas}
              className="px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-semibold hover:opacity-90 active:opacity-80 transition-opacity"
            >
              Codes match — dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (online) {
    return <>{banners}<Cockpit socket={socketRef.current} deviceId={activeDeviceId!} /></>;
  }
  return <>{banners}<ConnectScreen socket={socketRef.current} /></>;
}
