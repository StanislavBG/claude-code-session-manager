import { useState } from 'react';
import { requestOtp } from '../api';
import { trackFlow } from '../telemetry';

export const IcoLink = ({ size = 42 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M9 12h6" /><path d="M10 8H7a4 4 0 000 8h3M14 8h3a4 4 0 010 8h-3" /></svg>
);

/**
 * Generates a pairing code (OTP) to enter in the desktop Session Manager's
 * Settings → Phone remote, and shows the code cells, steps and expiry.
 */
export default function PairCode() {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true); setErr(null);
    trackFlow('pair', 'start');
    try { setCode((await requestOtp()).code); trackFlow('pair', 'code-issued'); }
    catch (e: any) { trackFlow('pair', 'fail', { reason: 'otp-error' }); setErr(e?.message || 'Failed to generate code'); }
    finally { setLoading(false); }
  };

  // 8-char code → cells (last group split by a dash like the design).
  const chars = (code ?? '').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 8).padEnd(8, ' ').split('');

  return (
    <>
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
          <li>Go to <span className="text-ink font-semibold">Settings → Phone remote</span> and turn on 'Allow remote control from the web'.</li>
          <li>Click 'Pair Device…' and enter this code.</li>
        </ol>
      ) : (
        <button
          data-track="connect-generate-code"
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
    </>
  );
}
