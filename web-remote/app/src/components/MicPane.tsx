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

/**
 * Pane 3: voice (Web Speech) → editable text → cmd:pty:write on the local session.
 * Falls back to a plain text box when SpeechRecognition is unavailable (iOS Safari).
 * No audio leaves the browser; STT runs in the browser. A recording indicator is
 * shown whenever the mic is live.
 */
export default function MicPane({ socket, deviceId, tabId }: Props) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const recRef = useRef<SR | null>(null);
  const supported = !!getSR();

  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* */ } }, []);

  const toggleMic = () => {
    if (listening) { try { recRef.current?.stop(); } catch { /* */ } return; }
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
    try { rec.start(); setListening(true); } catch (e: any) { setErr(e?.message || 'mic failed'); }
  };

  const send = async () => {
    const data = text.trim();
    if (!data || !socket) return;
    setSending(true);
    setErr(null);
    try {
      await socket.sendCommand('cmd:pty:write', deviceId, { tabId, data: data + '\n' });
      setText('');
    } catch (e: any) {
      setErr(e?.message || 'send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="border-t border-slate-800 bg-surface p-3 safe-bottom flex-shrink-0" data-testid="mic-pane">
      {err && <div className="text-xs text-red-400 mb-2" role="alert">{err}</div>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={supported ? 'Hold the mic or type a command…' : 'Type a command…'}
          rows={2}
          className="flex-1 resize-none rounded-lg bg-bg border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }}
        />
        <div className="flex flex-col gap-2">
          {supported && (
            <button
              onClick={toggleMic}
              aria-label={listening ? 'Stop recording' : 'Start recording'}
              aria-pressed={listening}
              className={`min-h-touch min-w-touch rounded-full flex items-center justify-center
                ${listening ? 'bg-red-500 sm-blink text-white' : 'bg-slate-700 text-slate-200 active:bg-slate-600'}`}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>
          )}
          <button
            onClick={send}
            disabled={!text.trim() || sending}
            className="min-h-touch min-w-touch rounded-full bg-indigo-500 text-white flex items-center justify-center disabled:opacity-40 active:bg-indigo-400"
            aria-label="Send command"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
      {listening && (
        <div className="mt-2 text-xs text-red-400 flex items-center gap-1.5" aria-live="assertive">
          <span className="w-2 h-2 rounded-full bg-red-500 sm-blink" /> Listening…
        </div>
      )}
    </section>
  );
}
