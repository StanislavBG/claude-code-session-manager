import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

vi.mock('../remoteApi', async () => {
  const actual = await vi.importActual<typeof import('../remoteApi')>('../remoteApi');
  return { ...actual, listProjects: vi.fn() };
});

import { listProjects, RemoteError } from '../remoteApi';
import Cockpit from '../components/Cockpit';
import { useStore } from '../store';
import { createReadyFallback, READY_FALLBACK_MS } from '../App';

const mocked = vi.mocked(listProjects);
const socket = { sendCommand: vi.fn() } as any;
const PROJECTS = [
  { cwd: '/p/alpha', title: 'Alpha', mainTabId: 't1', counts: { active: 1, proposed: 0, completed: 0 } },
];

function dev(id: string) {
  return { deviceId: id, isOnline: true, devicePubKey: 'pk-' + id } as any;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe('ready-gated first fetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.mockReset();
    mocked.mockResolvedValue({ projects: PROJECTS });
    useStore.setState({
      devices: [dev('d1'), dev('d2')], activeDeviceId: 'd1', route: { view: 'projects' },
      remoteReady: false, readyFallbackExpired: false, readyDeviceIds: [],
      awaitingDesktopConfirm: false, refreshKey: 0, wsConnected: true,
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('sends no request before ready and shows Loading, not an error', async () => {
    render(<Cockpit socket={socket} deviceId="d1" />);
    await flush();
    expect(mocked).not.toHaveBeenCalled();
    expect(screen.getByText('Loading projects…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends exactly one request after ready', async () => {
    render(<Cockpit socket={socket} deviceId="d1" />);
    await flush();
    act(() => useStore.getState().markRemoteReady('d1'));
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('project-row')).toBeInTheDocument();
  });

  it('re-fetches once when ready arrives while in the error state', async () => {
    useStore.setState({ remoteReady: true, readyDeviceIds: ['d1'] });
    mocked.mockRejectedValueOnce(new RemoteError('e2e_not_authenticated'));
    render(<Cockpit socket={socket} deviceId="d1" />);
    await flush();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => useStore.getState().markRemoteReady('d1'));
    await flush();
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('project-row')).toBeInTheDocument();
  });

  it('fallback expiry issues the request', async () => {
    render(<Cockpit socket={socket} deviceId="d1" />);
    const f = createReadyFallback(useStore.getState().stopAwaitingDesktop);
    f.arm();
    await flush();
    expect(mocked).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(READY_FALLBACK_MS); });
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('switching to an already-ready device requests immediately', async () => {
    useStore.setState({ readyDeviceIds: ['d2'] });
    render(<Cockpit socket={socket} deviceId="d1" />);
    await flush();
    expect(mocked).not.toHaveBeenCalled();
    act(() => useStore.getState().chooseDevice('d2'));
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith(socket, 'd1' /* deviceId prop from App is stale in this harness */);
  });

  it('switching to a not-ready device waits for its ready', async () => {
    render(<Cockpit socket={socket} deviceId="d1" />);
    act(() => useStore.getState().chooseDevice('d2'));
    await flush();
    expect(mocked).not.toHaveBeenCalled();
    act(() => useStore.getState().markRemoteReady('d2'));
    await flush();
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
