import { useMemo } from 'react';
import { useStore } from '../store';
import type { SessionMeta, SessionState } from '../types';
import { StateDot } from './StatePane';

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
    // Sort sessions within each group: active first.
    for (const list of byProject.values()) {
      list.sort((a, b) => liveRank(stateByTab[a.tabId]) - liveRank(stateByTab[b.tabId]));
    }
    return [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sessions, stateByTab]);

  return (
    <>
      {/* Backdrop (mobile) */}
      {navOpen && (
        <div
          className="absolute inset-0 bg-black/50 z-10 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <nav
        className={`
          absolute md:static inset-y-0 left-0 z-20 w-64 max-w-[80%] bg-surface border-r border-slate-800
          overflow-y-auto transition-transform md:translate-x-0
          ${navOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        aria-label="Sessions"
      >
        <div className="px-3 py-2 text-xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
          Sessions ({sessions.length})
        </div>
        {groups.length === 0 && (
          <div className="px-3 py-4 text-sm text-slate-500">No sessions.</div>
        )}
        {groups.map(([project, list]) => (
          <div key={project} className="py-1">
            <div className="px-3 py-1 text-xs font-medium text-slate-400 truncate">{project}</div>
            {list.map((s) => {
              const active = s.tabId === selectedTabId;
              return (
                <button
                  key={s.tabId}
                  onClick={() => selectTab(s.tabId)}
                  className={`
                    w-full flex items-center gap-2 px-3 py-2 text-left text-sm min-h-touch
                    ${active ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-300 active:bg-slate-800'}
                  `}
                  aria-current={active ? 'true' : undefined}
                >
                  <StateDot state={stateByTab[s.tabId]} />
                  <span className="flex-1 truncate">{s.title || s.tabId.slice(0, 10)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );
}
