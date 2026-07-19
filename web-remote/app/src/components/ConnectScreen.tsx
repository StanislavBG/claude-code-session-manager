import { useState } from 'react';
import { useStore } from '../store';
import { requestOtp } from '../api';
import type { RelaySocket } from '../ws';

const IcoBolt = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6z" /></svg>
);
const IcoLink = ({ size = 42 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M9 12h6" /><path d="M10 8H7a4 4 0 000 8h3M14 8h3a4 4 0 010 8h-3" /></svg>
);

/**
 * Shown when signed in but no paired device is online. Generates a pairing code
 * to enter in the desktop Session Manager's Remote tab.
 */
export default function ConnectScreen({
  socket: _socket, onRefresh,
}: { socket: RelaySocket | null; onRefresh: () => Promise<void> }) {
  const { devices, wsConnected } = useStore();
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const generate = async () => {
    setLoading(true); setErr(null);
    try { setCode((await requestOtp()).code); }
    catch (e: any) { setErr(e?.message || 'Failed to generate code'); }
    finally { setLoading(false); }
  };

  const refresh = async () => {
    setRefreshing(true); setErr(null);
    try { await onRefresh(); }
    catch (e: any) { setErr(e?.message || 'Failed to check for pairing'); }
    finally { setRefreshing(false); }
  };

  // 8-char code → cells (last group split by a dash like the design).
  const chars = (code ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8).padEnd(8, ' ').split('');

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

      <h1 className="font-serif text-[34px] font-semibold tracking-tight text-center mt-5 mb-2">Pair this phone</h1>
      <p className="text-center text-[14.5px] text-ink-soft leading-relaxed mb-7">
        On your desktop open <strong className="text-ink font-semibold">Configure → Remote</strong>, then enter
        the code below and enable remote control.
      </p>

      {/* code cells (shown once generated) */}
      {code && (
        <div className="flex gap-[7px] justify-center mb-5">
          {chars.map((ch, i) => (
            <span key={i} className="contents">
              <span className="w-8 h-[46px] rounded-[10px] grid place-items-center bg-card border-[1.5px] border-rule font-mono text-[22px] font-semibold text-ink select-all">
                {ch.trim()}
              </span>
              {i === 3 && <span className="self-center text-ink-mute text-xl font-light">–</span>}
            </span>
          ))}
        </div>
      )}

      {code ? (
        <ol className="text-sm text-ink-soft list-decimal list-inside space-y-1 mb-2 max-w-xs mx-auto">
          <li>Open Session Manager on your computer.</li>
          <li>Go to the <span className="text-ink font-semibold">Remote</span> tab.</li>
          <li>Enter this code and enable remote.</li>
        </ol>
      ) : (
        <button
          onClick={generate}
          disabled={loading}
          className="h-[54px] rounded-2xl bg-accent text-white text-base font-semibold flex items-center justify-center gap-2.5 shadow-[0_6px_18px_rgba(184,92,52,0.28)] active:opacity-90 disabled:opacity-50"
        >
          {loading
            ? <span className="rm-spin w-[18px] h-[18px] rounded-full border-[2.5px] border-white/40 border-t-white" />
            : <IcoLink size={19} />}
          {loading ? 'Generating…' : 'Generate pairing code'}
        </button>
      )}

      {code && <p className="text-center text-xs text-ink-mute mt-1">Code expires in 5 minutes.</p>}
      {err && <div className="mt-3 text-xs text-accent text-center" role="alert">{err}</div>}

      <div className="mt-7">
        {devices.length > 0 && (
          <>
            <div className="text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute mb-2">Paired devices</div>
            <div className="flex flex-col gap-1.5 mb-2">
              {devices.map((d) => (
                <div key={d.deviceId} className="flex items-center gap-2.5 py-1.5 text-ink-soft">
                  <span className={`w-2 h-2 rounded-full ${d.isOnline ? 'bg-sage' : 'bg-ink-mute'}`} />
                  <span className="font-mono text-xs truncate flex-1">{d.deviceId.slice(0, 12)}…</span>
                  <span className="text-xs text-ink-mute">{d.isOnline ? 'online' : 'offline'}</span>
                </div>
              ))}
            </div>
            <p className="mb-2 text-xs text-ink-mute">
              {wsConnected ? 'Waiting for a device to come online…' : 'Connecting to relay…'}
            </p>
          </>
        )}
        <button
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
