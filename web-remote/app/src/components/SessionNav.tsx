import { useMemo } from 'react';
import { useStore } from '../store';
import type { SessionMeta, SessionState } from '../types';
import { StateDot, StatePill } from './StatePane';

/** Short last path segment for a cwd, e.g. /home/me/Projects/foo → foo */
function projectName(cwd?: string): string {
  if (!cwd) return 'unknown';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

/**
 * Collapsible left-nav: sessions grouped by project (cwd), live sessions first.
 * Slide-over drawer on mobile; tap a session to select + subscribe.
 */
export default function SessionNav() {
  const { sessions, selectedTabId, selectTab, stateByTab, navOpen, setNavOpen } = useStore();

  const groups = useMemo(() => {
    const liveRank = (st: SessionState | undefined) =>
      st && st !== 'idle' && st !== 'unknown' ? 0 : 1;
    const byProject = new Map<string, SessionMeta[]>();
    for (const s of sessions) {
      const key = projectName(s.cwd);
      (byProject.get(key) ?? byProject.set(key, []).get(key)!).push(s);
    }
    for (const list of byProject.values()) {
      list.sort((a, b) => liveRank(stateByTab[a.tabId]) - liveRank(stateByTab[b.tabId]));
    }
    return [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions, stateByTab]);

  let cardIndex = 0;

  return (
    <>
      {/* Backdrop (mobile) */}
      {navOpen && (
        <div
          className="absolute inset-0 bg-black/40 z-10 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <nav
        className={`
          absolute md:static inset-y-0 left-0 z-20 w-72 max-w-[82%] bg-paper border-r border-edge
          overflow-y-auto rm-scroll transition-transform md:translate-x-0
          ${navOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        aria-label="Sessions"
      >
        <div className="px-4 pt-4 pb-2 text-[11.5px] font-bold uppercase tracking-[0.8px] text-ink-mute">
          Sessions ({sessions.length})
        </div>
        {groups.length === 0 && (
          <div className="px-4 py-5 text-sm text-ink-mute font-serif italic">No sessions.</div>
        )}
        {groups.map(([project, list]) => (
          <div key={project} className="px-3 py-1">
            <div className="px-1 py-1.5 text-xs font-mono font-medium text-ink-mute truncate">{project}</div>
            <div className="flex flex-col gap-2">
              {list.map((s) => {
                const active = s.tabId === selectedTabId;
                const st = stateByTab[s.tabId];
                const i = cardIndex++;
                return (
                  <button
                    key={s.tabId}
                    onClick={() => selectTab(s.tabId)}
                    className={`rm-in w-full flex items-center gap-3 px-3.5 py-3 text-left rounded-2xl border min-h-touch transition-colors
                      ${active ? 'bg-card border-accent/50 shadow-[0_0_0_1px_rgba(184,92,52,0.18)]' : 'bg-card border-edge active:bg-panel'}`}
                    style={{ animationDelay: `${i * 45}ms` }}
                    aria-current={active ? 'true' : undefined}
                  >
                    <StateDot state={st} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] font-semibold text-ink truncate">{s.title || projectName(s.cwd)}</div>
                      <div className="font-mono text-[11.5px] text-ink-mute truncate">{s.tabId.slice(0, 12)}</div>
                    </div>
                    <StatePill state={st} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="px-4 py-4 text-center text-xs text-ink-mute">
          {sessions.length} session{sessions.length === 1 ? '' : 's'} reachable from this device.
        </div>
      </nav>
    </>
  );
}
