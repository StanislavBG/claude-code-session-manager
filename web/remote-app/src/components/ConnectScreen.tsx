import { useState } from 'react';
import { useStore } from '../store';
import { revokeDevice } from '../api';
import type { RelaySocket } from '../ws';
import PairCode, { IcoLink } from './PairCode';

const IcoBolt = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6z" /></svg>
);
/**
 * Shown when signed in but no paired device is online. Generates a pairing code
 * to enter in the desktop Session Manager's Settings → Phone remote.
 */
export default function ConnectScreen({
  socket: _socket, onRefresh,
}: { socket: RelaySocket | null; onRefresh: () => Promise<void> }) {
  const { devices, wsConnected } = useStore();
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showPair, setShowPair] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  const hasDevices = devices.length > 0;
  // online first, then newest pairing first
  const rows = [...devices].sort((a, b) =>
    Number(b.isOnline) - Number(a.isOnline) || b.issuedAt - a.issuedAt);
  const offline = rows.filter((d) => !d.isOnline);
  const lastPairedId = offline[0]?.deviceId;

  const forget = async (ids: string[], message: string) => {
    if (!window.confirm(message)) return;
    setForgetting(true); setErr(null);
    try {
      await Promise.all(ids.map((id) => revokeDevice(id)));
      await onRefresh();
    } catch (e: any) { setErr(e?.message || 'Failed to forget device'); }
    finally { setForgetting(false); }
  };

  const refresh = async () => {
    setRefreshing(true); setErr(null);
    try { await onRefresh(); }
    catch (e: any) { setErr(e?.message || 'Failed to check for pairing'); }
    finally { setRefreshing(false); }
  };

  return (
    <div className="rm-scroll min-h-dvh overflow-auto flex flex-col px-7 pb-8 safe-top text-ink">
      <div className="h-12 flex-shrink-0" />
      {/* wordmark */}
      <div className="flex items-center gap-2.5 mb-10">
        <span className="w-[26px] h-[26px] rounded-lg bg-accent grid place-items-center text-white"><IcoBolt /></span>
        <span className="text-[15px] font-semibold text-ink">Session Manager</span>
        <span className="text-[13px] text-ink-mute font-mono">· remote</span>
      </div>

      {/* hero */}
      <div className="grid place-items-center mb-2">
        <div className="relative w-24 h-24 rounded-[26px] bg-card border border-edge grid place-items-center shadow-[0_10px_30px_rgba(120,80,40,0.12)]">
          <span className="text-accent"><IcoLink /></span>
          <span className="rm-pulse absolute top-3 right-3 w-2.5 h-2.5 rounded-full bg-sage" />
        </div>
      </div>

      {hasDevices ? (
        <>
          <h1 className="font-serif text-[34px] font-semibold tracking-tight text-center mt-5 mb-2">Your desktop is offline</h1>
          <p className="text-center text-[14.5px] text-ink-soft leading-relaxed mb-7">
            Open <strong className="text-ink font-semibold">Session Manager</strong> on it with Phone remote
            enabled and this phone will reconnect on its own. There's no need to pair again.
          </p>
        </>
      ) : (
        <>
          <h1 className="font-serif text-[34px] font-semibold tracking-tight text-center mt-5 mb-2">Pair this phone</h1>
          <p className="text-center text-[14.5px] text-ink-soft leading-relaxed mb-7">
            On your desktop open <strong className="text-ink font-semibold">Settings → Phone remote</strong>, turn on
            remote control, then click Pair Device… and enter the code below.
          </p>
        </>
      )}

      {(hasDevices && !showPair) ? (
        <button
          data-track="connect-pair-another"
          onClick={() => setShowPair(true)}
          className="h-10 rounded-xl border border-edge bg-card text-ink-soft text-sm font-medium active:opacity-80"
        >
          Pair another computer
        </button>
      ) : (
        <PairCode />
      )}
      {err && <div className="mt-3 text-xs text-accent text-center" role="alert">{err}</div>}

      <div className="mt-7">
        {hasDevices && (
          <>
            <div className="flex items-center mb-2">
              <div className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute flex-1">Paired devices</div>
              {offline.length >= 2 && (
                <button
                  data-track="connect-forget-offline"
                  onClick={() => forget(offline.map((d) => d.deviceId), `Forget ${offline.length} offline devices?`)}
                  disabled={forgetting}
                  className="text-xs text-accent font-medium disabled:opacity-50"
                >
                  {`Forget ${offline.length} offline`}
                </button>
              )}
            </div>
            <div className="flex flex-col gap-1.5 mb-2">
              {rows.map((d) => (
                <div key={d.deviceId} data-testid="device-row" className="flex items-center gap-2.5 py-1.5 text-ink-soft">
                  <span className={`w-2 h-2 rounded-full ${d.isOnline ? 'bg-sage' : 'bg-ink-mute'}`} />
                  <span className="font-mono text-xs truncate flex-1">{d.deviceId.slice(0, 12)}…</span>
                  {d.deviceId === lastPairedId && <span className="text-xs text-ink-mute">last paired</span>}
                  <span className="text-xs text-ink-mute">{d.isOnline ? 'online' : 'offline'}</span>
                  {!d.isOnline && (
                    <button
                      data-track="connect-forget-device"
                      onClick={() => forget([d.deviceId], 'Forget this device? You can pair it again later.')}
                      disabled={forgetting}
                      className="text-xs text-accent font-medium disabled:opacity-50"
                    >
                      Forget
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="mb-2 text-xs text-ink-mute">
              {wsConnected ? 'Waiting for a device to come online…' : 'Connecting to relay…'}
            </p>
          </>
        )}
        <button
          data-track="connect-refresh"
          onClick={refresh}
          disabled={refreshing}
          className="w-full h-10 rounded-xl border border-edge bg-card text-ink-soft text-sm font-medium flex items-center justify-center gap-2 active:opacity-80 disabled:opacity-50"
        >
          {refreshing
            ? <span className="rm-spin w-3.5 h-3.5 rounded-full border-2 border-ink-mute/40 border-t-ink-mute" />
            : null}
          {refreshing ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      <div className="flex-1" />
      <div className="flex items-center justify-center gap-2 mt-7 text-[11.5px] text-ink-mute">
        <span className="w-1.5 h-1.5 rounded-full bg-butter" />
        self-hosted relay · end-to-end encrypted
      </div>
    </div>
  );
}
