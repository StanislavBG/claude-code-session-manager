// Bundled by remote-renderer-chain.browser.spec.ts (esbuild, iife) and run in real Chromium.
import { createRoot } from 'react-dom/client';
import RemoteRenderer from '../../components/RemoteRenderer';
import type { FrameSocket } from '../../remoteApi';

// The spec plants a fake FrameSocket on window.__socket. Typed locally, not on the global Window:
// real-chain-entry.tsx shares this tsc program and declares Window.__socket as a RelaySocket.
createRoot(document.body.appendChild(document.createElement('div'))).render(
  <RemoteRenderer socket={(window as unknown as { __socket: FrameSocket }).__socket} deviceId="d1" fallback={<div data-testid="drill">drill</div>} />,
);
