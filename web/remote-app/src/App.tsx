import { useEffect, useRef } from 'react';
import {
  ClerkProvider, SignedIn, SignedOut, SignIn, useAuth,
} from '@clerk/clerk-react';
import { useStore } from './store';
import { getMe, getDevices, setTokenGetter } from './api';
import { getAppInfo } from './remoteApi';
import { pickActiveDevice, loadPreferredDevice } from './devices';
import { RelaySocket } from './ws';
import Cockpit from './components/Cockpit';
import ConnectScreen from './components/ConnectScreen';
import { trackFlow, trackScreen } from './telemetry';
import type { Envelope, SessionState } from './types';

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

/** How long to wait after sas:pending for event:remote:ready before asking anyway. */
export const READY_FALLBACK_MS = 20_000;

/**
 * Fallback timer for version skew (an older desktop never sends event:remote:ready).
 * arm() restarts the countdown; clear() cancels it. On expiry `onReady` fires so the
 * Projects screen issues its request and surfaces the RemoteError guidance.
 */
export function createReadyFallback(onReady: () => void, ms: number = READY_FALLBACK_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => { timer = null; onReady(); }, ms);
  };
  return { arm, clear };
}

function AppInner() {
  const { getToken } = useAuth();
  const {
    activeDeviceId,
    setMe, setDevices, setDeviceOnline, setActiveDevice,
    setWsConnected, setTabState, reset,
    setPendingSas, addKeyMismatch, stopAwaitingDesktop,
  } = useStore();
  const socketRef = useRef<RelaySocket | null>(null);
  const fallbackRef = useRef<ReturnType<typeof createReadyFallback> | null>(null);

  // Fetches /devices and re-applies TOFU key pinning. Shared by the mount-time
  // bootstrap and the event-triggered refresh (device paired after initial load).
  const refreshDevices = async (): Promise<void> => {
    const r = await getDevices();
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
    // Keep an already-active desktop; otherwise adopt the preferred/newest online one.
    const st = useStore.getState();
    if (!st.activeDeviceId) {
      const pick = pickActiveDevice(st.devices, st.activeDeviceId, loadPreferredDevice());
      if (pick) setActiveDevice(pick);
    }
  };

  // Wire Clerk token into the relay API client, then bootstrap.
  useEffect(() => {
    setTokenGetter(() => getToken());
    getMe()
      .then((user) => {
        setMe(user);
        if (!user) return;
        return refreshDevices();
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getToken, setMe, setDevices, addKeyMismatch]);

  // Connect the relay socket once.
  useEffect(() => {
    const socket = new RelaySocket((connected) => setWsConnected(connected));
    socketRef.current = socket;
    const fallback = createReadyFallback(stopAwaitingDesktop);
    fallbackRef.current = fallback;
    const infoFetched = new Set<string>();
    socket.connect().catch(console.error);

    const offStatus = socket.on('event:device:status', async (m: Envelope) => {
      if (m.deviceId && m.status) {
        const deviceId = m.deviceId;
        // A device paired after the initial getDevices() fetch (the normal
        // pair-on-desktop-while-phone-is-open flow) won't be in the store yet;
        // refresh before relying on setDeviceOnline, which only updates existing entries.
        const known = useStore.getState().devices.some((d) => d.deviceId === deviceId);
        if (!known) {
          await refreshDevices().catch(console.error);
        }
        const online = m.status === 'connected';
        setDeviceOnline(deviceId, online);
        if (!online) {
          socket.resetE2E(deviceId);
          useStore.getState().clearRemoteReady(deviceId);
          infoFetched.delete(deviceId);
        } else {
          const st = useStore.getState();
          const pick = pickActiveDevice(st.devices, st.activeDeviceId, loadPreferredDevice());
          if (pick) setActiveDevice(pick);
          // Negotiate E2E (P-256 ECDH → AES-256-GCM) only with the active desktop, so a
          // second desktop never prompts for a 6-digit code uninvited. Idempotent.
          if (pick === deviceId) {
            const dev = useStore.getState().devices.find((d) => d.deviceId === deviceId);
            if (dev?.devicePubKey) socket.initiateE2E(deviceId, dev.devicePubKey).catch(console.warn);
          }
        }
      }
    });
    const offState = socket.on('event:session:state', (m: Envelope) => {
      if (m.deviceId && m.deviceId !== useStore.getState().activeDeviceId) return;
      const p = m.payload as { tabId?: string; state?: SessionState } | undefined;
      if (p?.tabId && p.state) setTabState(p.tabId, p.state);
    });
    // Internal event: SAS computed after e2e:ready; show to user for manual comparison.
    const offSas = socket.on('sas:pending', (m: Envelope) => {
      const p = m.payload as { sas?: string } | undefined;
      if (m.deviceId && p?.sas && m.deviceId === useStore.getState().activeDeviceId) {
        setPendingSas({ deviceId: m.deviceId, sas: p.sas });
        fallback.arm();
      }
    });
    // Desktop: phone is SAS-confirmed / key-pinned — commands are accepted now.
    const offReady = socket.on('event:remote:ready', (m: Envelope) => {
      const active = useStore.getState().activeDeviceId;
      if (m.deviceId) useStore.getState().markRemoteReady(m.deviceId);
      else if (active) useStore.getState().markRemoteReady(active);
      if (!m.deviceId || m.deviceId === active) {
        fallback.clear();
        trackFlow('pair', 'success');
        const id = m.deviceId ?? active;
        if (id && !infoFetched.has(id)) {
          infoFetched.add(id);
          getAppInfo(socket, id)
            .then((info) => {
              const name = info.hostname?.trim();
              if (name) {
                useStore.getState().setDeviceMeta(id, {
                  name, platform: info.platform, version: info.version, seenAt: Date.now(),
                });
              }
            })
            .catch(() => {});
        }
      }
    });

    return () => {
      offStatus(); offState(); offSas(); offReady();
      fallback.clear();
      fallbackRef.current = null;
      socket.destroy();
      socketRef.current = null;
      reset();
    };
  }, [setWsConnected, setDeviceOnline, setActiveDevice, setTabState, reset, setPendingSas, stopAwaitingDesktop]);

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

  // Arm the version-skew fallback whenever we start waiting for the active desktop's
  // event:remote:ready (online + E2E initiated); clear it once ready arrives.
  const remoteReady = useStore((s) => s.remoteReady);
  const wsConnected = useStore((s) => s.wsConnected);
  useEffect(() => {
    const f = fallbackRef.current;
    if (!f) return;
    if (online && device?.devicePubKey && wsConnected && !remoteReady) f.arm();
    else f.clear();
  }, [online, device?.deviceId, device?.devicePubKey, wsConnected, remoteReady]);

  const showConnect = !online;
  useEffect(() => { if (showConnect) trackScreen('connect'); }, [showConnect]);
  const hasPendingSas = !!pendingSas;
  useEffect(() => { if (hasPendingSas) trackScreen('sas-confirm'); }, [hasPendingSas]);

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
              Confirm the desktop (Settings → Phone remote) shows the same 6-digit code:
            </p>
            <div className="text-3xl font-mono tracking-[0.3em] text-accent mb-4 select-all">
              {pendingSas.sas}
            </div>
            <p className="text-ink-mute mb-3 text-xs">
              Now click “Codes match — confirm” on your computer (Settings → Phone remote). Your sessions appear once you do.
            </p>
            <button
              onClick={clearPendingSas}
              data-track="sas-dismiss"
              className="px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-semibold hover:opacity-90 active:opacity-80 transition-opacity"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (online) {
    return <>{banners}<Cockpit socket={socketRef.current} deviceId={activeDeviceId!} /></>;
  }
  return <>{banners}<ConnectScreen socket={socketRef.current} onRefresh={refreshDevices} /></>;
}
