import { useState } from 'react';
import { useStore } from '../store';
import { deviceLabel, platformLabel } from '../devices';
import PairCode from './PairCode';

interface Props {
  onClose: () => void;
}

/** Bottom sheet: every paired desktop, switch to an online one, or pair another. */
export default function DevicePicker({ onClose }: Props) {
  const devices = useStore((s) => s.devices);
  const deviceMeta = useStore((s) => s.deviceMeta);
  const activeDeviceId = useStore((s) => s.activeDeviceId);
  const chooseDevice = useStore((s) => s.chooseDevice);
  const [pairing, setPairing] = useState(false);

  const rows = devices
    .map((d) => ({ d, label: deviceLabel(d.deviceId, deviceMeta[d.deviceId]) }))
    .sort((a, b) => Number(b.d.isOnline) - Number(a.d.isOnline) || a.label.localeCompare(b.label));

  const pick = (id: string) => {
    chooseDevice(id);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="Switch computer"
      data-testid="device-picker"
      className="fixed bottom-0 inset-x-0 z-50 safe-bottom bg-paper border-t border-edge px-4 py-5 shadow-[0_-10px_40px_rgba(120,80,40,0.18)] max-h-[85dvh] overflow-y-auto"
    >
      <div className="max-w-sm mx-auto">
        <div className="flex items-center mb-3">
          <p className="flex-1 font-serif text-xl font-semibold text-ink">Your computers</p>
          <button
            onClick={onClose}
            data-track="device-picker-close"
            className="px-3 py-1.5 rounded-lg text-sm text-ink-soft hover:text-ink"
          >
            Close
          </button>
        </div>
        <ul className="mb-4 divide-y divide-edge">
          {rows.map(({ d, label }) => {
            const current = d.deviceId === activeDeviceId;
            const plat = platformLabel(deviceMeta[d.deviceId]?.platform);
            return (
              <li key={d.deviceId}>
                <button
                  onClick={() => pick(d.deviceId)}
                  disabled={!d.isOnline || current}
                  data-testid={`device-row-${d.deviceId}`}
                  data-track="device-picker-select"
                  className="w-full flex items-center gap-3 py-3 text-left disabled:opacity-60"
                >
                  <span
                    data-testid={d.isOnline ? 'dot-online' : 'dot-offline'}
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${d.isOnline ? 'bg-sage' : 'bg-ink-mute'}`}
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-ink truncate">{label}</span>
                    <span className="block text-xs text-ink-mute truncate">
                      {[plat, d.isOnline ? 'online' : 'offline'].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {current && <span className="text-xs font-mono text-accent">Current</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {pairing ? (
          <PairCode />
        ) : (
          <button
            onClick={() => setPairing(true)}
            data-track="device-picker-pair"
            className="w-full px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-semibold hover:opacity-90 active:opacity-80 transition-opacity"
          >
            Pair another computer
          </button>
        )}
      </div>
    </div>
  );
}
