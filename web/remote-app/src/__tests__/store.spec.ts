import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';

describe('session store', () => {
  beforeEach(() => useStore.getState().reset());

  it('go* set the route and reset returns to projects', () => {
    const st = useStore.getState();
    expect(st.route).toEqual({ view: 'projects' });
    st.goSessions('/p/a', 'A');
    expect(useStore.getState().route).toEqual({ view: 'sessions', cwd: '/p/a', title: 'A' });
    const target = { kind: 'main' as const, mainTabId: 't1', title: 'A' };
    useStore.getState().goSession('/p/a', 'A', target);
    expect(useStore.getState().route).toEqual({ view: 'session', cwd: '/p/a', title: 'A', target });
    useStore.getState().goProjects();
    expect(useStore.getState().route).toEqual({ view: 'projects' });
    useStore.getState().goSessions('/p/a', 'A');
    useStore.getState().reset();
    expect(useStore.getState().route).toEqual({ view: 'projects' });
  });

  it('bumpRefresh increments refreshKey', () => {
    const before = useStore.getState().refreshKey;
    useStore.getState().bumpRefresh();
    expect(useStore.getState().refreshKey).toBe(before + 1);
  });

  it('records per-tab state and summary independently', () => {
    const { setTabState, setTabSummary } = useStore.getState();
    setTabState('a', 'thinking');
    setTabSummary({ tabId: 'a', summary: 'did a thing', ts: 1 });
    expect(useStore.getState().stateByTab.a).toBe('thinking');
    expect(useStore.getState().summaryByTab.a.summary).toBe('did a thing');
  });
});
