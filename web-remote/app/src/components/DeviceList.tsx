import { useCallback } from 'react';
import { useStore } from '../store';
import { revokeDevice, getDevices } from '../api';
import Header from './Header';
import type { RelaySocket } from '../ws';

interface Props {
  socket: RelaySocket | null;
}

export default function DeviceList({ socket: _socket }: Props) {
  const { devices, setDevices, setScreen } = useStore();

  const handleRevoke = useCallback(
    async (deviceId: string) => {
      await revokeDevice(deviceId);
      const r = await getDevices();
      setDevices(r.devices);
    },
    [setDevices],
  );

  return (
    <div className="flex flex-col min-h-dvh bg-bg" data-testid="device-list">
      <Header />

      <main className="flex-1 overflow-y-auto px-4 py-4 pb-safe flex flex-col gap-3">
        {devices.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-center">
            <p className="text-slate-400 text-sm">No paired devices yet.</p>
            <p className="text-slate-500 text-xs max-w-xs">
              Open Session Manager on your machine and enter the pairing code.
            </p>
          </div>
        )}

        {devices.map((device) => (
          <div
            key={device.deviceId}
            className="flex flex-col gap-3 rounded-xl bg-surface p-4 border border-slate-700"
          >
            <div className="flex items-center gap-3">
              {/* Online indicator */}
              <span
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                  device.isOnline ? 'bg-green-500' : 'bg-slate-500'
                }`}
                aria-label={device.isOnline ? 'Online' : 'Offline'}
              />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-100 truncate text-sm">
                  {device.deviceId.slice(0, 8)}…
                </div>
                <div className="text-xs text-slate-400">
                  Paired {new Date(device.issuedAt).toLocaleDateString()}
                </div>
              </div>
              {device.isOnline && (
                <button
                  onClick={() =>
                    setScreen({
                      kind: 'device',
                      deviceId: device.deviceId,
                      tab: 'terminal',
                    })
                  }
                  className="
                    min-h-touch min-w-touch px-3 rounded-lg bg-indigo-600
                    text-white text-sm font-medium active:bg-indigo-700
                    flex items-center justify-center
                  "
                  aria-label={`Connect to device ${device.deviceId.slice(0, 8)}`}
                >
                  Connect
                </button>
              )}
            </div>

            <button
              onClick={() => handleRevoke(device.deviceId)}
              className="
                self-start text-xs text-red-400 active:text-red-300
                min-h-touch flex items-center
              "
              aria-label={`Revoke device ${device.deviceId.slice(0, 8)}`}
            >
              Revoke access
            </button>
          </div>
        ))}
      </main>

      {/* Add Device FAB */}
      <div className="fixed bottom-6 right-4 safe-bottom">
        <button
          onClick={() => setScreen({ kind: 'pairing' })}
          className="
            flex items-center gap-2 rounded-full bg-indigo-600 px-5
            text-white font-medium text-sm shadow-lg
            min-h-touch active:bg-indigo-700
          "
          data-testid="add-device-btn"
          aria-label="Add a new device"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Device
        </button>
      </div>
    </div>
  );
}
