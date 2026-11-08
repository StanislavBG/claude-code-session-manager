// Bundled by phone-drilldown-chain.browser.spec.ts: the REAL Cockpit + useStore + RelaySocket, wired the way
// App.tsx wires them. Clerk and the relay's /devices API are not part of this chain, so the store is seeded
// with what refreshDevices() would have produced: one online computer whose E2E key the browser pinned, as the
// active device. Cockpit picks phone or full UI itself (viewMode.ts, real matchMedia): nothing here forces it.
// Production calls initiateE2E before the socket is open and again on auth:ok (two e2e:hello per connect).
import { createRoot } from 'react-dom/client';
import Cockpit from '../../components/Cockpit';
import { useStore } from '../../store';
import { RelaySocket } from '../../ws';
import type { Envelope, SessionState } from '../../types';

interface PhoneChainWindow {
  __cfg: { deviceId: string; devicePubKey: string };
  __socket: RelaySocket;
  /** Every envelope type the socket dispatched, in order (spec diagnostics). */
  __rx: string[];
}

const w = window as unknown as PhoneChainWindow;
const { deviceId, devicePubKey } = w.__cfg;

// App.tsx: new RelaySocket((connected) => setWsConnected(connected)).
const socket = new RelaySocket((connected) => useStore.getState().setWsConnected(connected));
w.__socket = socket;
w.__rx = [];
socket.on('*', (m) => { w.__rx.push(m.type); });

// App.tsx refreshDevices(): setDevices, then setActiveDevice(pickActiveDevice(...)).
useStore.getState().setDevices([{ deviceId, email: 'owner@example.test', issuedAt: 0, isOnline: true, devicePubKey }]);
useStore.getState().setActiveDevice(deviceId);

// App.tsx: the desktop pinned this browser's key and accepts commands now.
socket.on('event:remote:ready', (m: Envelope) => {
  useStore.getState().markRemoteReady(m.deviceId ?? deviceId);
});
// App.tsx: live per-tab state, read by the session screen's StatePane.
socket.on('event:session:state', (m: Envelope) => {
  if (m.deviceId && m.deviceId !== useStore.getState().activeDeviceId) return;
  const p = m.payload as { tabId?: string; state?: SessionState } | undefined;
  if (p?.tabId && p.state) useStore.getState().setTabState(p.tabId, p.state);
});
socket.on('auth:ok', () => { void socket.initiateE2E(deviceId, devicePubKey); });
void socket.connect();
void socket.initiateE2E(deviceId, devicePubKey);

createRoot(document.getElementById('root')!).render(<Cockpit socket={socket} deviceId={deviceId} />);
