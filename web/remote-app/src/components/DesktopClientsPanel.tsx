import { useCallback, useEffect, useState } from 'react';
import { ApiError, getClients, requestClientOtp, revokeClient } from '../api';
import type { DesktopClient } from '../types';

function errText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Pair another desktop Session Manager as a remote client; list + revoke paired ones. */
export default function DesktopClientsPanel() {
  const [clients, setClients] = useState<DesktopClient[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintErr, setMintErr] = useState<string | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getClients();
      setClients(res?.clients ?? []);
      setListErr(null);
    } catch (e) {
      setListErr(errText(e, 'Failed to load desktop clients'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const mint = async () => {
    setMinting(true); setMintErr(null);
    try {
      setCode((await requestClientOtp()).code);
    } catch (e) {
      setCode(null);
      setMintErr(
        e instanceof ApiError && e.status === 429
          ? 'Too many codes — try again later.'
          : errText(e, 'Failed to generate code'),
      );
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (clientId: string) => {
    try {
      await revokeClient(clientId);
    } catch (e) {
      setListErr(errText(e, 'Failed to revoke client'));
      return;
    }
    await load();
  };

  return (
    <section className="px-4 py-4 border-t border-edge text-ink" aria-label="Desktop clients">
      <div className="pb-2 text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute">Desktop clients</div>
      <button
        data-testid="desktop-client-mint"
        onClick={mint}
        disabled={minting}
        className="w-full min-h-touch px-3 rounded-2xl border border-edge bg-paper text-ink text-[15px] font-semibold active:bg-panel disabled:opacity-60"
      >
        {minting ? 'Generating…' : 'Pair a desktop'}
      </button>
      {code && (
        <div className="mt-3">
          <div data-testid="desktop-client-code" className="font-mono text-lg font-semibold tracking-widest text-ink break-all">{code}</div>
          <p className="mt-1 text-xs text-ink-mute">
            Enter this in Session Manager → Settings → Phone remote → Remote machines. Valid 5 minutes, single use.
          </p>
        </div>
      )}
      {mintErr && <p className="mt-2 text-xs text-ink">{mintErr}</p>}
      {listErr && <p className="mt-2 text-xs text-ink">{listErr}</p>}
      <ul className="mt-3 flex flex-col gap-2">
        {clients.map((c) => (
          <li key={c.clientId} data-testid="desktop-client-row" className="flex items-center gap-2 px-3 py-2 rounded-2xl border border-edge bg-paper">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-ink truncate">{c.clientName || 'Unnamed desktop'}</div>
              <div className="text-[11.5px] text-ink-mute">{c.expiresAt ? `Expires ${new Date(c.expiresAt).toLocaleDateString()}` : 'Never expires'}</div>
            </div>
            <button
              data-testid="desktop-client-revoke"
              onClick={() => revoke(c.clientId)}
              className="min-h-touch px-3 rounded-xl border border-edge text-ink text-[13px] active:bg-panel"
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
