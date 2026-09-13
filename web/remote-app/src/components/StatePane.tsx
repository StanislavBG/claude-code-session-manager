import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { SessionState } from '../types';

interface Meta { label: string; dot: string; anim: string; }

// CSS animation classes are defined in index.css and disabled under
// prefers-reduced-motion (a11y gate).
const META: Record<SessionState, Meta> = {
  idle:             { label: 'Idle · your turn', dot: 'bg-butter',   anim: '' },
  thinking:         { label: 'Thinking…',        dot: 'bg-accent',   anim: 'rm-pulse' },
  running:          { label: 'Running…',         dot: 'bg-sage',     anim: 'rm-pulse' },
  'awaiting-input': { label: 'Awaiting input',   dot: 'bg-butter',   anim: 'rm-pulse' },
  error:            { label: 'Error',            dot: 'bg-accent',   anim: '' },
  unknown:          { label: '—',                dot: 'bg-ink-mute', anim: '' },
};

/** Small state indicator dot, reused in the session nav. */
export function StateDot({ state }: { state?: SessionState }) {
  const m = META[state ?? 'unknown'];
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${m.dot} ${m.anim}`} aria-hidden="true" />;
}

/** Uppercase status pill used on session cards. */
const PILL: Partial<Record<SessionState, { label: string; cls: string }>> = {
  running:          { label: 'running',  cls: 'text-sage bg-[#e4ebd6] border-[#cbd8b0]' },
  thinking:         { label: 'thinking', cls: 'text-sage bg-[#e4ebd6] border-[#cbd8b0]' },
  'awaiting-input': { label: 'needs you', cls: 'text-butter bg-[#f7eed5] border-[#e8d9ab]' },
  idle:             { label: 'idle',     cls: 'text-ink-mute bg-panel border-edge' },
  error:            { label: 'error',    cls: 'text-accent bg-[#f8e8e0] border-[#eccdbe]' },
  unknown:          { label: 'idle',     cls: 'text-ink-mute bg-panel border-edge' },
};
export function StatePill({ state }: { state?: SessionState }) {
  const p = PILL[state ?? 'unknown'] ?? PILL.unknown!;
  return (
    <span className={`text-[10.5px] font-bold uppercase tracking-[0.3px] px-2 py-0.5 rounded-full border ${p.cls}`}>
      {p.label}
    </span>
  );
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
      className="flex items-center gap-3 px-4 h-16 border-b border-edge bg-paper flex-shrink-0"
      aria-live="polite"
      data-testid="state-pane"
    >
      <span className={`w-3.5 h-3.5 rounded-full ${m.dot} ${m.anim}`} aria-hidden="true" />
      <span className="text-base font-medium text-ink flex-1">{m.label}</span>
      {busy && <span className="text-sm tabular-nums font-mono text-ink-mute">{fmt(elapsed)}</span>}
    </section>
  );
}
