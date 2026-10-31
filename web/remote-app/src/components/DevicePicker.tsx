import { useState } from 'react';
import { useStore } from '../store';
import { deviceLabel, platformLabel } from '../devices';
import { revokeDevice } from '../api';
import PairCode from './PairCode';

interface Props {
  onClose: () => void;
  onRefreshDevices?: () => Promise<void>;
}

/** Bottom sheet: every paired desktop, switch to an online one, or pair another. */
export default function DevicePicker({ onClose, onRefreshDevices }: Props) {
  const devices = useStore((s) => s.devices);
  const deviceMeta = useStore((s) => s.deviceMeta);
  const activeDeviceId = useStore((s) => s.activeDeviceId);
  const chooseDevice = useStore((s) => s.chooseDevice);
  const [pairing, setPairing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const remove = async (id: string, label: string, online: boolean, current: boolean) => {
    const msg = online
      ? `Remove ${label}? It disconnects now and must be paired again from its Settings → Phone remote.`
      : `Remove ${label}? It can be paired again later.`;
    if (!window.confirm(msg)) return;
    setRemovingId(id); setErr(null);
    try {
      await revokeDevice(id);
      await onRefreshDevices?.();
      if (current) onClose();
    } catch (e: any) {
      setErr(e?.message || 'Failed to remove computer');
    } finally { setRemovingId(null); }
  };

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
              <li key={d.deviceId} className="flex items-center gap-2">
                <button
                  onClick={() => pick(d.deviceId)}
                  disabled={!d.isOnline || current}
                  data-testid={`device-row-${d.deviceId}`}
                  data-track="device-picker-select"
                  className="flex-1 min-w-0 flex items-center gap-3 py-3 text-left disabled:opacity-60"
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
                <button
                  onClick={() => remove(d.deviceId, label, d.isOnline, current)}
                  disabled={removingId !== null}
                  data-testid={`device-remove-${d.deviceId}`}
                  data-track="device-picker-remove"
                  className="px-2 py-1.5 rounded-lg text-xs text-ink-soft hover:text-ink disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
        {err && (
          <p role="alert" className="mb-3 text-sm text-red-600">{err}</p>
        )}
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
