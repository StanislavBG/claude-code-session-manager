import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { SessionState } from '../types';

interface Meta { label: string; dot: string; anim: string; }

// CSS animation classes are defined in index.css and disabled under
// prefers-reduced-motion (a11y gate).
const META: Record<SessionState, Meta> = {
  idle:             { label: 'Idle · your turn', dot: 'bg-slate-400',  anim: '' },
  thinking:         { label: 'Thinking…',        dot: 'bg-indigo-400', anim: 'sm-pulse' },
  running:          { label: 'Running…',         dot: 'bg-sky-400',    anim: 'sm-pulse' },
  'awaiting-input': { label: 'Awaiting input',   dot: 'bg-amber-400',  anim: 'sm-blink' },
  error:            { label: 'Error',            dot: 'bg-red-500',    anim: '' },
  unknown:          { label: '—',                dot: 'bg-slate-600',  anim: '' },
};

/** Small state indicator dot, reused in the session nav. */
export function StateDot({ state }: { state?: SessionState }) {
  const m = META[state ?? 'unknown'];
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${m.dot} ${m.anim}`} aria-hidden="true" />;
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pane 1: live session state + minimal busy animation + elapsed timer. */
export default function StatePane({ tabId }: { tabId: string }) {
  const state = (useStore((s) => s.stateByTab[tabId]) ?? 'unknown') as SessionState;
  const m = META[state];
  const since = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => { since.current = Date.now(); setElapsed(0); }, [state]);
  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - since.current), 1000);
    return () => clearInterval(t);
  }, []);

  const busy = state === 'thinking' || state === 'running';

  return (
    <section
      className="flex items-center gap-3 px-4 h-16 border-b border-slate-800 bg-bg flex-shrink-0"
      aria-live="polite"
      data-testid="state-pane"
    >
      <span className={`w-3.5 h-3.5 rounded-full ${m.dot} ${m.anim}`} aria-hidden="true" />
      <span className="text-base font-medium flex-1">{m.label}</span>
      {busy && <span className="text-sm tabular-nums text-slate-400">{fmt(elapsed)}</span>}
    </section>
  );
}
