import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
      sendCommand: vi.fn().mockResolvedValue(undefined),
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

const NEW_DEVICE_ID = 'device-paired-after-mount';

beforeEach(() => {
  clerkState.isSignedIn = true;
  vi.clearAllMocks();
  useStore.getState().reset();
  useStore.setState({ devices: [], activeDeviceId: null, wsConnected: false });
  for (const k of Object.keys(handlers)) delete handlers[k];

  getDevicesMock.mockReset();
  // Bootstrap fetch: no paired devices yet.
  getDevicesMock.mockResolvedValueOnce({ devices: [] });
  // Refresh fetch (triggered by the status event below): the newly paired device.
  getDevicesMock.mockResolvedValueOnce({
    devices: [{ deviceId: NEW_DEVICE_ID, email: 'a@b.com', issuedAt: 1, isOnline: false }],
  });
});

describe('device pairing after mount', () => {
  it('stays on ConnectScreen when no device is known yet', async () => {
    render(<App />);
    await waitFor(() => expect(getDevicesMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('connect-screen')).toBeInTheDocument();
    expect(useStore.getState().devices).toEqual([]);
  });

  it('refreshes devices and transitions into Cockpit when event:device:status arrives for an unknown device', async () => {
    render(<App />);
    await waitFor(() => expect(getDevicesMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('connect-screen')).toBeInTheDocument();

    // Relay pushes a status event for a device paired out-of-band on desktop,
    // after the initial bootstrap fetch — the bug scenario.
    await act(async () => {
      await handlers['event:device:status']({
        type: 'event:device:status', id: '1', ts: 1,
        deviceId: NEW_DEVICE_ID, status: 'connected',
      });
    });

    await waitFor(() => expect(getDevicesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const dev = useStore.getState().devices.find((d) => d.deviceId === NEW_DEVICE_ID);
      expect(dev?.isOnline).toBe(true);
    });
    expect(useStore.getState().activeDeviceId).toBe(NEW_DEVICE_ID);
    await waitFor(() => expect(screen.getByTestId('cockpit')).toBeInTheDocument());
  });
});
