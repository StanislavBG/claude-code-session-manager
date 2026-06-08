import { useState } from 'react';
import { useStore } from '../store';
import { requestOtp } from '../api';
import type { RelaySocket } from '../ws';

/**
 * Shown when signed in but no paired device is online. Generates a pairing code
 * to enter in the desktop Session Manager's Web Remote tab.
 */
export default function ConnectScreen({ socket: _socket }: { socket: RelaySocket | null }) {
  const { devices, wsConnected } = useStore();
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true); setErr(null);
    try { setCode((await requestOtp()).code); }
    catch (e: any) { setErr(e?.message || 'Failed to generate code'); }
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-dvh bg-bg text-slate-100 flex flex-col items-center justify-center p-6 gap-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold">Connect a device</h1>
        <p className="text-sm text-slate-400 mt-1">
          Pair this phone with Session Manager running on your computer.
        </p>
      </div>

      <div className="w-full max-w-sm rounded-xl bg-surface border border-slate-800 p-5">
        {code ? (
          <>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Pairing code</div>
            <div className="text-3xl font-mono tracking-[0.3em] text-center text-indigo-300 select-all">
              {code}
            </div>
            <ol className="mt-4 text-sm text-slate-400 list-decimal list-inside space-y-1">
              <li>Open Session Manager on your computer.</li>
              <li>Go to the <span className="text-slate-200">Web Remote</span> tab.</li>
              <li>Enter this code and enable remote.</li>
            </ol>
            <p className="mt-3 text-xs text-slate-500">Code expires in 5 minutes.</p>
          </>
        ) : (
          <button
            onClick={generate}
            disabled={loading}
            className="w-full min-h-touch rounded-lg bg-indigo-500 text-white font-medium active:bg-indigo-400 disabled:opacity-50"
          >
            {loading ? 'Generating…' : 'Generate pairing code'}
          </button>
        )}
        {err && <div className="mt-3 text-xs text-red-400" role="alert">{err}</div>}
      </div>

      {devices.length > 0 && (
        <div className="w-full max-w-sm text-sm">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Paired devices</div>
          {devices.map((d) => (
            <div key={d.deviceId} className="flex items-center gap-2 py-1.5 text-slate-300">
              <span className={`w-2 h-2 rounded-full ${d.isOnline ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="font-mono text-xs truncate flex-1">{d.deviceId.slice(0, 12)}…</span>
              <span className="text-xs text-slate-500">{d.isOnline ? 'online' : 'offline'}</span>
            </div>
          ))}
          <p className="mt-2 text-xs text-slate-500">
            {wsConnected ? 'Waiting for a device to come online…' : 'Connecting to relay…'}
          </p>
        </div>
      )}
    </div>
  );
}
