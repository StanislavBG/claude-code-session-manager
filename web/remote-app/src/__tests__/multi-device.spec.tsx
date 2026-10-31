import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import React from 'react';

// vi.hoisted runs before any module is imported (even hoisted vi.mock calls),
// so values referenced in mock factories below must be created here.
const { clerkState, handlers, RelaySocketMock, getDevicesMock, getTokenMock } = vi.hoisted(() => {
  const handlers: Record<string, (m: any) => void> = {};
  return {
    clerkState: { isSignedIn: true },
    handlers,
    // Stable identity across renders — an unstable getToken would retrigger the
    // bootstrap useEffect (it's a dep) on every render and loop.
    getTokenMock: vi.fn().mockResolvedValue('test-token'),
    RelaySocketMock: vi.fn(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, cb: (m: any) => void) => {
        handlers[event] = cb;
        return () => { delete handlers[event]; };
      }),
      destroy: vi.fn(),
      sendCommand: vi.fn().mockResolvedValue({ payload: { version: '1.2.3', platform: 'linux', hostname: 'work-laptop' } }),
      resetE2E: vi.fn(),
      initiateE2E: vi.fn().mockResolvedValue(undefined),
    })),
    getDevicesMock: vi.fn(),
  };
});

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn: ({ children }: { children: React.ReactNode }) =>
    clerkState.isSignedIn ? <>{children}</> : null,
  SignedOut: ({ children }: { children: React.ReactNode }) =>
    !clerkState.isSignedIn ? <>{children}</> : null,
  SignIn: () => <div data-testid="clerk-sign-in" />,
  useAuth: () => ({ getToken: getTokenMock }),
}));

// getDevices is stateful across the test: first call (bootstrap) returns no
// devices — reproducing "phone opens app before pairing happens on desktop".
vi.mock('../api', () => ({
  getMe: vi.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.com' }),
  getDevices: getDevicesMock,
  setTokenGetter: vi.fn(),
  requestOtp: vi.fn().mockResolvedValue({ code: 'TEST-OTP' }),
  getWsTicket: vi.fn().mockResolvedValue({ ticket: 'test-ticket' }),
  RELAY_API_BASE: '/api/sm-relay',
  RELAY_WSS_URL: 'wss://bilko.run/projects/session-manager/relay',
}));

vi.mock('../ws', () => ({
  RelaySocket: RelaySocketMock,
}));

vi.mock('../components/Cockpit', () => ({
  default: () => <div data-testid="cockpit" />,
}));

vi.mock('../components/ConnectScreen', () => ({
  default: () => <div data-testid="connect-screen" />,
}));

import App from '../App';
import { useStore } from '../store';
import { PREFERRED_KEY, META_PREFIX } from '../devices';

const dev = (deviceId: string, isOnline: boolean, issuedAt: number) =>
  ({ deviceId, email: 'a@b.com', issuedAt, isOnline });
const status = (deviceId: string) =>
  act(async () => {
    await handlers['event:device:status']({ type: 'event:device:status', id: '1', ts: 1, deviceId, status: 'connected' });
  });

beforeEach(() => {
  clerkState.isSignedIn = true;
  vi.clearAllMocks();
  localStorage.clear();
  useStore.getState().reset();
  useStore.setState({ devices: [], activeDeviceId: null, wsConnected: false, deviceMeta: {} });
  for (const k of Object.keys(handlers)) delete handlers[k];
  getDevicesMock.mockReset();
});

describe('multi-desktop', () => {
  it('a second desktop coming online does not replace the active one', async () => {
    getDevicesMock.mockResolvedValue({ devices: [dev('A', true, 1), dev('B', false, 2)] });
    render(<App />);
    await waitFor(() => expect(useStore.getState().activeDeviceId).toBe('A'));
    await status('B');
    expect(useStore.getState().devices.find((d) => d.deviceId === 'B')?.isOnline).toBe(true);
    expect(useStore.getState().activeDeviceId).toBe('A');
  });

  it('chooses the preferred online desktop at boot', async () => {
    localStorage.setItem(PREFERRED_KEY, 'A');
    getDevicesMock.mockResolvedValue({ devices: [dev('A', true, 1), dev('B', true, 2)] });
    render(<App />);
    await waitFor(() => expect(useStore.getState().activeDeviceId).toBe('A'));
  });

  it("ignores a non-active desktop's sas:pending", async () => {
    getDevicesMock.mockResolvedValue({ devices: [dev('A', true, 1), dev('B', true, 2)] });
    localStorage.setItem(PREFERRED_KEY, 'A');
    render(<App />);
    await waitFor(() => expect(useStore.getState().activeDeviceId).toBe('A'));
    act(() => { handlers['sas:pending']({ type: 'sas:pending', id: '2', ts: 1, deviceId: 'B', payload: { sas: '111111' } }); });
    expect(useStore.getState().pendingSas).toBeNull();
    act(() => { handlers['sas:pending']({ type: 'sas:pending', id: '3', ts: 1, deviceId: 'A', payload: { sas: '222222' } }); });
    expect(useStore.getState().pendingSas).toEqual({ deviceId: 'A', sas: '222222' });
  });

  it('remote:ready stores the hostname in deviceMeta and localStorage', async () => {
    getDevicesMock.mockResolvedValue({ devices: [dev('A', true, 1)] });
    render(<App />);
    await waitFor(() => expect(useStore.getState().activeDeviceId).toBe('A'));
    act(() => { handlers['event:remote:ready']({ type: 'event:remote:ready', id: '4', ts: 1, deviceId: 'A' }); });
    await waitFor(() => expect(useStore.getState().deviceMeta.A?.name).toBe('work-laptop'));
    expect(JSON.parse(localStorage.getItem(META_PREFIX + 'A')!).name).toBe('work-laptop');
  });

  it('switches to another online desktop when the active one is removed', async () => {
    getDevicesMock.mockResolvedValueOnce({ devices: [dev('A', true, 1), dev('B', true, 2)] });
    localStorage.setItem(PREFERRED_KEY, 'A');
    render(<App />);
    await waitFor(() => expect(useStore.getState().activeDeviceId).toBe('A'));
    getDevicesMock.mockResolvedValue({ devices: [dev('B', true, 2)] });
    await status('Z'); // unknown id forces a /devices refresh
    expect(useStore.getState().activeDeviceId).toBe('B');
    expect(localStorage.getItem(PREFERRED_KEY)).toBeNull();
  });

  it('leaves no active desktop when the last one is removed', async () => {
    getDevicesMock.mockResolvedValueOnce({ devices: [dev('A', true, 1)] });
    render(<App />);
    await waitFor(() => expect(useStore.getState().activeDeviceId).toBe('A'));
    getDevicesMock.mockResolvedValue({ devices: [] });
    await status('Z');
    expect(useStore.getState().activeDeviceId).toBeNull();
  });
});
