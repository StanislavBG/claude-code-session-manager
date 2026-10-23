import { useEffect, useState } from 'react';
import type { RelaySocket } from '../ws';
import { trackFlow, trackScreen } from '../telemetry';

interface Macro {
  id: string;
  label: string;
  agentName: string;
  tag: string;
  prompt: string;
  projects?: string[];
  inputs?: { name: string; label: string; default?: string; required?: boolean; options?: string[] }[];
}
interface Options {
  agents: { name: string; description?: string }[];
  tags: string[];
  macros: Macro[];
  macroInputs?: boolean;
}

interface Props {
  socket: RelaySocket | null;
  deviceId: string;
  cwd: string;
  project: string;
  onClose: () => void;
  onStarted?: () => void;
}

/** Pull an error string out of a command response envelope, if it carries one. */
function respError(resp: any): string | null {
  const p = resp?.payload;
  if (resp?.status === 'error' || resp?.status === 'err') return p?.error || p?.message || 'request failed';
  if (p && typeof p === 'object' && typeof p.error === 'string') return p.error;
  return null;
}

/** Bottom sheet: pick agent + tag (or a macro), write the prompt, start a session on the desktop. */
export default function NewSessionSheet({ socket, deviceId, cwd, project, onClose, onStarted }: Props) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [agentName, setAgentName] = useState('');
  const [tag, setTag] = useState('');
  const [title, setTitle] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [macro, setMacro] = useState<Macro | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  useEffect(() => {
    trackScreen('new-session-sheet');
    trackFlow('new-session', 'start');
  }, []);

  useEffect(() => {
    if (!socket) return;
    let live = true;
    socket
      .sendCommand('cmd:session:options', deviceId, {})
      .then((resp) => {
        if (!live) return;
        const e = respError(resp);
        if (e) return setErr(e);
        const p: any = resp?.payload ?? {};
        setOpts({ agents: p.agents ?? [], tags: p.tags ?? [], macros: p.macros ?? [], macroInputs: p.macroInputs === true });
      })
      .catch((e) => live && setErr(e?.message || 'could not load options'));
    return () => {
      live = false;
    };
  }, [socket, deviceId]);

  const macros = (opts?.macros ?? []).filter(
    (m) => m.projects?.includes('*') || m.projects?.includes(cwd),
  );

  const applyMacro = (m: Macro) => {
    setAgentName(m.agentName);
    setTag(m.tag);
    setTitle(m.label);
    setTitleEdited(true);
    setPrompt(m.prompt);
    setMacro(m);
    setInputValues(Object.fromEntries((m.inputs ?? []).map((i) => [i.name, i.default ?? ''])));
  };

  const onPrompt = (v: string) => {
    setPrompt(v);
    if (!titleEdited) setTitle(v.slice(0, 60));
  };

  const dictate = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return setErr('Voice input is not supported in this browser');
    const rec = new SR();
    rec.lang = 'en-US';
    rec.onresult = (ev: any) => {
      const t = Array.from(ev.results as ArrayLike<any>).map((r) => r[0].transcript).join(' ');
      onPrompt(prompt ? `${prompt} ${t}` : t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const finalTitle = (title.trim() || prompt.trim().slice(0, 60)).slice(0, 120);
  const blocked = !!macro?.inputs?.length && opts?.macroInputs !== true;
  const ready = !!agentName && !!tag && !!prompt.trim() && !!finalTitle && !busy && !!socket && !blocked;

  const start = async () => {
    if (!socket || !ready) return;
    setBusy(true);
    setErr(null);
    trackFlow('new-session', 'submit', { tag });
    try {
      const resp = await socket.sendCommand('cmd:session:create', deviceId, {
        cwd,
        agentName,
        tag,
        title: finalTitle,
        prompt,
        ...(macro ? { macroId: macro.id } : {}),
        ...(macro?.inputs?.length ? { inputs: inputValues } : {}),
      });
      const e = respError(resp);
      if (e) {
        trackFlow('new-session', 'fail', { tag, reason: 'desktop-error' });
        setErr(e);
        return;
      }
      trackFlow('new-session', 'success', { tag });
      onStarted?.();
      onClose();
    } catch (e: any) {
      trackFlow('new-session', 'fail', { tag, reason: 'send-error' });
      setErr(e?.message || 'could not start session');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-xl border border-edge bg-card text-ink px-3 py-2 text-[15px] min-h-touch';

  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" role="dialog" aria-label={`New session in ${project}`}>
      <div className="w-full max-h-[90dvh] overflow-y-auto rm-scroll bg-paper border-t border-edge rounded-t-3xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="font-serif text-lg font-semibold truncate">New session · {project}</div>
          <button onClick={onClose} data-track="new-session-close" className="min-h-touch min-w-touch text-ink-mute" aria-label="Close">✕</button>
        </div>

        {!opts && !err && <div className="text-sm text-ink-mute font-serif italic">Loading…</div>}

        {macros.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="Macros">
            {macros.map((m) => (
              <button
                key={m.id}
                onClick={() => applyMacro(m)}
                data-track="new-session-macro"
                data-track-redact=""
                className="px-3 py-1.5 rounded-full border border-edge bg-card text-sm text-ink active:bg-panel"
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {macro?.inputs?.length ? (
          <div className="flex flex-col gap-3" role="group" aria-label="Macro inputs">
            {macro.inputs.map((i) => (
              <label key={i.name} className="text-xs font-bold uppercase text-ink-mute">
                {i.label}{i.required ? ' *' : ''}
                {i.options?.length ? (
                  <select
                    aria-label={i.label}
                    className={field}
                    value={inputValues[i.name] ?? ''}
                    onChange={(e) => setInputValues((v) => ({ ...v, [i.name]: e.target.value }))}
                  >
                    {!i.required && <option value=""></option>}
                    {i.options.map((o) => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label={i.label}
                    className={field}
                    maxLength={500}
                    value={inputValues[i.name] ?? ''}
                    onChange={(e) => setInputValues((v) => ({ ...v, [i.name]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        ) : null}

        <label className="text-xs font-bold uppercase text-ink-mute">
          Agent
          <select aria-label="Agent" className={field} value={agentName} onChange={(e) => setAgentName(e.target.value)}>
            <option value="">Select agent…</option>
            {(opts?.agents ?? []).map((a) => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-bold uppercase text-ink-mute">
          Tag
          <select aria-label="Tag" className={field} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Select tag…</option>
            {(opts?.tags ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="text-xs font-bold uppercase text-ink-mute">
          Title
          <input
            aria-label="Title"
            className={field}
            maxLength={120}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleEdited(true);
            }}
          />
        </label>
        <label className="text-xs font-bold uppercase text-ink-mute">
          Prompt
          <textarea
            aria-label="Prompt"
            className={`${field} min-h-[7rem]`}
            value={prompt}
            onChange={(e) => onPrompt(e.target.value)}
          />
        </label>
        <button onClick={dictate} data-track="new-session-dictate" disabled={listening} className="self-start text-sm text-accent min-h-touch" aria-label="Dictate prompt">
          {listening ? 'Listening…' : '🎤 Dictate'}
        </button>

        {blocked && (
          <div role="alert" className="text-sm text-red-700">
            Update Session Manager on your computer to use this macro's inputs from the phone.
          </div>
        )}
        {err && <div role="alert" className="text-sm text-red-700">{err}</div>}

        <button
          onClick={start}
          data-track="new-session-start"
          disabled={!ready}
          className="min-h-touch rounded-2xl bg-accent text-white font-semibold disabled:opacity-40"
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </div>
  );
}
