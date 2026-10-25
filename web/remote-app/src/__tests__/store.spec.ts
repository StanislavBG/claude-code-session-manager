import { describe, it, expect, beforeEach, vi } from 'vitest';

const dev = vi.hoisted(() => ({
  loadDeviceMeta: vi.fn(),
  saveDeviceMeta: vi.fn(),
  savePreferredDevice: vi.fn(),
}));
vi.mock('../devices', () => dev);

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

  it('records per-tab state', () => {
    const { setTabState } = useStore.getState();
    setTabState('a', 'thinking');
    expect(useStore.getState().stateByTab.a).toBe('thinking');
  });

  describe('per-device', () => {
    const meta = { name: 'Mac', platform: 'darwin', version: '1', seenAt: 1 };
    const mk = (id: string) => ({ deviceId: id, isOnline: true, issuedAt: 1 }) as never;
    beforeEach(() => {
      vi.clearAllMocks();
      dev.loadDeviceMeta.mockReturnValue(null);
      useStore.setState({ deviceMeta: {}, readyDeviceIds: [], activeDeviceId: null });
      useStore.getState().reset();
    });

    it('setDevices hydrates missing meta only', () => {
      dev.loadDeviceMeta.mockImplementation((id: string) => (id === 'a' ? meta : null));
      useStore.setState({ deviceMeta: { b: { ...meta, name: 'keep' } } });
      useStore.getState().setDevices([mk('a'), mk('b')]);
      const m = useStore.getState().deviceMeta;
      expect(m.a).toEqual(meta);
      expect(m.b.name).toBe('keep');
      expect(dev.loadDeviceMeta).not.toHaveBeenCalledWith('b');
    });

    it('readiness is isolated per desktop', () => {
      useStore.setState({ activeDeviceId: 'a' });
      const k = useStore.getState().refreshKey;
      useStore.getState().markRemoteReady('b');
      let s = useStore.getState();
      expect(s.readyDeviceIds).toEqual(['b']);
      expect(s.remoteReady).toBe(false);
      expect(s.refreshKey).toBe(k);
      useStore.getState().markRemoteReady('a');
      s = useStore.getState();
      expect(s.remoteReady).toBe(true);
      expect(s.refreshKey).toBe(k + 1);
      useStore.getState().clearRemoteReady('b');
      s = useStore.getState();
      expect(s.readyDeviceIds).toEqual(['a']);
      expect(s.remoteReady).toBe(true);
      useStore.getState().clearRemoteReady('a');
      expect(useStore.getState().remoteReady).toBe(false);
      useStore.getState().markRemoteReady();
      expect(useStore.getState().remoteReady).toBe(true);
      useStore.getState().clearRemoteReady();
      s = useStore.getState();
      expect(s.readyDeviceIds).toEqual([]);
      expect(s.remoteReady).toBe(false);
    });

    it('setActiveDevice resets screen state on change, no-op on same id', () => {
      useStore.setState({ readyDeviceIds: ['b'] });
      useStore.getState().setActiveDevice('a');
      useStore.getState().goSessions('/p', 'P');
      useStore.getState().setTabState('t', 'thinking');
      useStore.setState({ pendingSas: { deviceId: 'a', sas: '1' }, awaitingDesktopConfirm: true });
      const k = useStore.getState().refreshKey;
      useStore.getState().setActiveDevice('a');
      expect(useStore.getState().route.view).toBe('sessions');
      expect(useStore.getState().refreshKey).toBe(k);
      useStore.getState().setActiveDevice('b');
      const s = useStore.getState();
      expect(s.route).toEqual({ view: 'projects' });
      expect(s.stateByTab).toEqual({});
      expect(s.pendingSas).toBeNull();
      expect(s.awaitingDesktopConfirm).toBe(false);
      expect(s.remoteReady).toBe(true);
      expect(s.refreshKey).toBe(k + 1);
    });

    it('chooseDevice persists then activates; setDeviceMeta persists; reset keeps meta', () => {
      useStore.getState().chooseDevice('x');
      expect(dev.savePreferredDevice).toHaveBeenCalledWith('x');
      expect(useStore.getState().activeDeviceId).toBe('x');
      useStore.getState().setDeviceMeta('x', meta);
      expect(dev.saveDeviceMeta).toHaveBeenCalledWith('x', meta);
      useStore.setState({ readyDeviceIds: ['x'] });
      useStore.getState().reset();
      expect(useStore.getState().readyDeviceIds).toEqual([]);
      expect(useStore.getState().deviceMeta.x).toEqual(meta);
    });
  });
});
