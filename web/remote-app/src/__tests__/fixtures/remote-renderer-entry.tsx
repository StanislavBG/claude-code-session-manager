// Bundled by remote-renderer-chain.browser.spec.ts (esbuild, iife) and run in real Chromium.
import { createRoot } from 'react-dom/client';
import RemoteRenderer from '../../components/RemoteRenderer';
import type { FrameSocket } from '../../remoteApi';

declare global {
  interface Window { __socket: FrameSocket }
}

createRoot(document.body.appendChild(document.createElement('div'))).render(
  <RemoteRenderer socket={window.__socket} deviceId="d1" fallback={<div data-testid="drill">drill</div>} />,
);
