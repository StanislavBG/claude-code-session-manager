import { useState, useEffect } from 'react';
import { requestOtp } from '../api';

interface Props {
  onClose: () => void;
}

export default function PairingModal({ onClose }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    requestOtp()
      .then((r) => {
        if (!cancelled) {
          setCode(r.code);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Failed to generate pairing code';
          setError(msg);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Format 8-char code as two groups of 4 for readability
  const formatted = code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Pair a new device"
      data-testid="pairing-modal"
    >
      <div className="
        w-full sm:max-w-sm bg-surface rounded-t-2xl sm:rounded-2xl
        p-6 flex flex-col gap-5 border border-slate-700
        safe-bottom
      ">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">
            Pair a Device
          </h2>
          <button
            onClick={onClose}
            className="min-h-touch min-w-touch flex items-center justify-center text-slate-400 active:text-slate-100 -mr-2"
            aria-label="Close pairing dialog"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading && (
          <p className="text-slate-400 text-sm text-center py-4">
            Generating code…
          </p>
        )}

        {error && (
          <p className="text-red-400 text-sm text-center py-4" role="alert">
            {error}
          </p>
        )}

        {formatted && (
          <>
            <div className="flex flex-col gap-3">
              <p className="text-slate-400 text-sm">
                Open <strong className="text-slate-200">Session Manager</strong> on your machine, go to{' '}
                <strong className="text-slate-200">Settings → Remote Access</strong>, and enter:
              </p>

              <div
                className="
                  flex items-center justify-center rounded-xl bg-bg
                  border border-slate-600 py-4
                "
                aria-label={`Pairing code: ${formatted}`}
                data-testid="pairing-code"
              >
                <span className="text-3xl font-mono font-bold tracking-[0.2em] text-indigo-300 select-all">
                  {formatted}
                </span>
              </div>

              <p className="text-xs text-slate-500 text-center">
                Code expires in 5 minutes · Case-insensitive
              </p>
            </div>

            <button
              onClick={onClose}
              className="
                w-full min-h-touch rounded-xl bg-indigo-600 text-white
                font-medium text-sm active:bg-indigo-700
              "
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
