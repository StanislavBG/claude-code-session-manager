import { useEffect, useRef, useState } from 'react';
import type { RelaySocket } from '../ws';

interface Props {
  socket: RelaySocket | null;
  deviceId: string;
  tabId: string;
}

// Minimal Web Speech typings (not in standard lib.dom).
type SR = {
  lang: string; interimResults: boolean; continuous: boolean;
  start: () => void; stop: () => void;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
};
function getSR(): (new () => SR) | null {
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

const QUICK = ['continue', 'run the tests', '/compact', 'explain the diff', 'commit'];

const IcoSend = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor"><path d="M4 12l16-7-6 16-3-7z" /></svg>
);
const IcoMic = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3M9 21h6" /></svg>
);
const IcoX = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
);

/**
 * Pane 3: voice (Web Speech) → editable text → cmd:pty:write on the local session.
 * Falls back to a plain text box when SpeechRecognition is unavailable (iOS Safari).
 * No audio leaves the browser; STT runs in the browser. A recording indicator is
 * shown whenever the mic is live (privacy invariant).
 */
export default function MicPane({ socket, deviceId, tabId }: Props) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const recRef = useRef<SR | null>(null);
  const supported = !!getSR();

  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* */ } }, []);

  const startMic = () => {
    const Ctor = getSR();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      let t = '';
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      setText(t);
    };
    rec.onerror = (e: any) => { setErr(e?.error || 'mic error'); setListening(false); };
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setErr(null);
    setText('');
    try { rec.start(); setListening(true); setSheetOpen(true); } catch (e: any) { setErr(e?.message || 'mic failed'); }
  };

  const stopMic = () => { try { recRef.current?.stop(); } catch { /* */ } setListening(false); };

  const send = async (msg?: string) => {
    const data = (msg ?? text).trim();
    if (!data || !socket) return;
    setSending(true);
    setErr(null);
    try {
      await socket.sendCommand('cmd:pty:write', deviceId, { tabId, data: data + '\n' });
      setText('');
      setSheetOpen(false);
    } catch (e: any) {
      setErr(e?.message || 'send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Quick command chips */}
      <div className="flex gap-2 overflow-x-auto rm-scroll px-3.5 py-2.5 bg-panel border-t border-edge flex-shrink-0">
        {QUICK.map((q) => (
          <button
            key={q}
            onClick={() => send(q)}
            disabled={sending}
            className="flex-shrink-0 rounded-full border border-edge bg-card text-ink-soft font-mono text-xs px-3.5 py-1.5 active:bg-panel disabled:opacity-50 whitespace-nowrap"
          >
            {q}
          </button>
        ))}
      </div>

      {/* Command bar */}
      <section className="border-t border-edge bg-panel px-3.5 py-3 safe-bottom flex-shrink-0" data-testid="mic-pane">
        {err && <div className="text-xs text-accent mb-2" role="alert">{err}</div>}
        <div className="flex items-center gap-2.5">
          <div className="flex-1 flex items-center bg-card border border-edge rounded-[22px] pl-4 pr-1.5 h-[46px]">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={supported ? 'Message this session…' : 'Type a command…'}
              className="flex-1 bg-transparent border-0 outline-none text-[14.5px] text-ink placeholder:text-ink-mute"
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            />
            {text.trim()
              ? (
                <button
                  onClick={() => send()}
                  disabled={sending}
                  className="w-9 h-9 rounded-full bg-accent text-white grid place-items-center disabled:opacity-50"
                  aria-label="Send command"
                >
                  <IcoSend />
                </button>
              )
              : <span className="w-9" />}
          </div>
          {supported && (
            <button
              onClick={startMic}
              aria-label="Start voice input"
              className="w-[46px] h-[46px] rounded-full bg-sage text-white grid place-items-center flex-shrink-0 shadow-[0_4px_14px_rgba(111,125,82,0.35)] active:opacity-90"
            >
              <IcoMic />
            </button>
          )}
        </div>
      </section>

      {/* Voice bottom sheet — bound to live Web Speech state */}
      {sheetOpen && (
        <div className="absolute inset-0 z-30 flex flex-col justify-end" data-testid="voice-sheet">
          <div
            className="absolute inset-0 bg-[rgba(20,14,8,0.45)] backdrop-blur-[2px]"
            onClick={() => { stopMic(); setSheetOpen(false); }}
            aria-hidden="true"
          />
          <div className="relative rm-sheet bg-paper rounded-t-[26px] px-6 pt-5 pb-7 safe-bottom shadow-[0_-10px_40px_rgba(0,0,0,0.25)]">
            <div className="w-10 h-[5px] rounded-full bg-rule mx-auto mb-5" />
            <div className="flex items-center gap-2.5 mb-4" aria-live="assertive">
              <span className={`w-2.5 h-2.5 rounded-full ${listening ? 'bg-accent rm-pulse' : 'bg-sage'}`} />
              <span className={`text-sm font-semibold ${listening ? 'text-accent' : 'text-sage'}`}>
                {listening ? 'Listening…' : 'Ready to send'}
              </span>
              <span className="ml-auto font-mono text-xs text-ink-mute">voice → session</span>
            </div>

            {/* waveform — animated while listening */}
            <div className="flex items-center justify-center gap-1 h-14 mb-4">
              {Array.from({ length: 28 }).map((_, i) => (
                <span
                  key={i}
                  className="w-1 rounded bg-accent origin-center"
                  style={{
                    height: 40,
                    background: listening ? undefined : 'var(--tw-sage, #6f7d52)',
                    opacity: listening ? 1 : 0.4,
                    animation: listening ? `rmBar ${0.5 + (i % 5) * 0.13}s ease-in-out ${i * 0.04}s infinite` : 'none',
                  }}
                />
              ))}
            </div>

            <div className="min-h-[52px] bg-card border border-edge rounded-2xl px-4 py-3.5 text-[15px] text-ink leading-snug mb-4">
              {text || <span className="text-ink-mute">Speak now…</span>}
              {listening && <span className="rm-caret inline-block w-0.5 h-[17px] bg-accent align-middle ml-0.5" />}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => { stopMic(); setSheetOpen(false); setText(''); }}
                className="flex-1 inline-flex items-center justify-center gap-2 border border-edge bg-card text-ink-soft h-[52px] rounded-2xl text-[15px] font-semibold active:bg-panel"
              >
                <IcoX /> Cancel
              </button>
              <button
                onClick={() => { stopMic(); send(); }}
                disabled={!text.trim() || sending}
                className="flex-[1.4] inline-flex items-center justify-center gap-2 bg-accent text-white h-[52px] rounded-2xl text-[15px] font-semibold disabled:bg-panel disabled:text-ink-mute"
              >
                <IcoSend /> Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
