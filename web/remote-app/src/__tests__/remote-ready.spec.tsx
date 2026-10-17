import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStore } from '../store';
import { createReadyFallback, READY_FALLBACK_MS } from '../App';

describe('markRemoteReady', () => {
  beforeEach(() => {
    useStore.setState({ awaitingDesktopConfirm: true, refreshKey: 3 });
  });

  it('clears awaitingDesktopConfirm and bumps refreshKey', () => {
    useStore.getState().markRemoteReady();
    const s = useStore.getState();
    expect(s.awaitingDesktopConfirm).toBe(false);
    expect(s.refreshKey).toBe(4);
  });
});

describe('remoteReady suppresses the SAS banner', () => {
  const sas = { deviceId: 'd1', sas: '123456' };
  beforeEach(() => {
    useStore.setState({
      remoteReady: false, pendingSas: null, awaitingDesktopConfirm: false, refreshKey: 0,
    });
  });

  it('first-time pairing: setPendingSas shows the banner', () => {
    useStore.getState().setPendingSas(sas);
    const s = useStore.getState();
    expect(s.pendingSas).toEqual(sas);
    expect(s.awaitingDesktopConfirm).toBe(true);
  });

  it('ready-then-sas: sas:pending after ready is suppressed', () => {
    useStore.getState().markRemoteReady();
    useStore.getState().setPendingSas(sas);
    const s = useStore.getState();
    expect(s.remoteReady).toBe(true);
    expect(s.pendingSas).toBeNull();
    expect(s.awaitingDesktopConfirm).toBe(false);
  });

  it('sas-then-ready: ready clears a pending sas', () => {
    useStore.getState().setPendingSas(sas);
    useStore.getState().markRemoteReady();
    const s = useStore.getState();
    expect(s.pendingSas).toBeNull();
    expect(s.awaitingDesktopConfirm).toBe(false);
  });

  it('clearRemoteReady re-enables the banner', () => {
    useStore.getState().markRemoteReady();
    useStore.getState().clearRemoteReady();
    useStore.getState().setPendingSas(sas);
    expect(useStore.getState().pendingSas).toEqual(sas);
  });

  it('reset re-enables the banner', () => {
    useStore.getState().markRemoteReady();
    useStore.getState().reset();
    expect(useStore.getState().remoteReady).toBe(false);
    useStore.getState().setPendingSas(sas);
    expect(useStore.getState().pendingSas).toEqual(sas);
  });
});

describe('createReadyFallback', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onReady after 20 s', () => {
    const onReady = vi.fn();
    createReadyFallback(onReady).arm();
    vi.advanceTimersByTime(READY_FALLBACK_MS - 1);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does not fire once cleared', () => {
    const onReady = vi.fn();
    const f = createReadyFallback(onReady);
    f.arm();
    f.clear();
    vi.advanceTimersByTime(READY_FALLBACK_MS * 2);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('re-arming restarts the countdown (new sas:pending)', () => {
    const onReady = vi.fn();
    const f = createReadyFallback(onReady);
    f.arm();
    vi.advanceTimersByTime(15_000);
    f.arm();
    vi.advanceTimersByTime(15_000);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('drives the store: refreshKey bumps when the fallback fires', () => {
    useStore.setState({ awaitingDesktopConfirm: true, refreshKey: 0 });
    createReadyFallback(useStore.getState().markRemoteReady).arm();
    vi.advanceTimersByTime(READY_FALLBACK_MS);
    expect(useStore.getState().awaitingDesktopConfirm).toBe(false);
    expect(useStore.getState().refreshKey).toBe(1);
  });
});
