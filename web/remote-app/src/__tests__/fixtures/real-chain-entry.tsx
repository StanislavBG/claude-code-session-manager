// Bundled by real-chain.browser.spec.ts: the REAL RelaySocket + RemoteRenderer, mounted as Cockpit does
// (RemoteRenderer appears once event:remote:ready arrives). Production calls initiateE2E both before the
// socket is open and again on auth:ok, so the desktop sees two e2e:hello per connect.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import RemoteRenderer from '../../components/RemoteRenderer';
import { RelaySocket } from '../../ws';

declare global {
  interface Window { __cfg: { deviceId: string; devicePubKey: string }; __socket: RelaySocket; __rx: string[] }
}

const { deviceId, devicePubKey } = window.__cfg;
const socket = new RelaySocket();
window.__socket = socket;
window.__rx = [];
socket.on('*', (m) => { window.__rx.push(m.type); });

function Root() {
  const [ready, setReady] = useState(false);
  useEffect(() => socket.on('event:remote:ready', () => setReady(true)), []);
  return ready
    ? <RemoteRenderer key={deviceId} socket={socket} deviceId={deviceId} fallback={<div data-testid="drill">drill</div>} />
    : null;
}

socket.on('auth:ok', () => { void socket.initiateE2E(deviceId, devicePubKey); });
void socket.connect();
void socket.initiateE2E(deviceId, devicePubKey);
createRoot(document.body.appendChild(document.createElement('div'))).render(<Root />);
