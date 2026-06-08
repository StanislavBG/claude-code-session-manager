import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';

describe('session store', () => {
  beforeEach(() => useStore.getState().reset());

  it('auto-selects the first session and keeps a valid selection', () => {
    const { setSessions } = useStore.getState();
    setSessions([{ tabId: 'a', cwd: '/p/a' }, { tabId: 'b', cwd: '/p/b' }]);
    expect(useStore.getState().selectedTabId).toBe('a');

    useStore.getState().selectTab('b');
    setSessions([{ tabId: 'b', cwd: '/p/b' }, { tabId: 'c', cwd: '/p/c' }]);
    expect(useStore.getState().selectedTabId).toBe('b'); // selection preserved
  });

  it('drops selection when the selected session disappears', () => {
    const { setSessions, selectTab } = useStore.getState();
    setSessions([{ tabId: 'a', cwd: '/p/a' }]);
    selectTab('a');
    setSessions([{ tabId: 'z', cwd: '/p/z' }]);
    expect(useStore.getState().selectedTabId).toBe('z');
  });

  it('records per-tab state and summary independently', () => {
    const { setTabState, setTabSummary } = useStore.getState();
    setTabState('a', 'thinking');
    setTabSummary({ tabId: 'a', summary: 'did a thing', ts: 1 });
    expect(useStore.getState().stateByTab.a).toBe('thinking');
    expect(useStore.getState().summaryByTab.a.summary).toBe('did a thing');
  });
});
