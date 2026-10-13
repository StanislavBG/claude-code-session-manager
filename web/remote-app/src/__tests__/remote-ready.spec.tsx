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
