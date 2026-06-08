import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

// vi.hoisted runs before any module is imported (even hoisted vi.mock calls),
// so values returned here are safe to reference in mock factories.
const { clerkState, RelaySocketMock } = vi.hoisted(() => ({
  clerkState: { isSignedIn: false },
  RelaySocketMock: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockReturnValue(() => {}),
    destroy: vi.fn(),
    sendCommand: vi.fn().mockResolvedValue(undefined),
    initiateE2E: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Clerk: ClerkProvider is a passthrough; SignedIn/SignedOut gate on clerkState.isSignedIn.
vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn: ({ children }: { children: React.ReactNode }) =>
    clerkState.isSignedIn ? <>{children}</> : null,
  SignedOut: ({ children }: { children: React.ReactNode }) =>
    !clerkState.isSignedIn ? <>{children}</> : null,
  SignIn: () => <div data-testid="clerk-sign-in" />,
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue('test-token') }),
}));

// API: prevent any real network calls from AppInner's useEffect bootstrap.
vi.mock('../api', () => ({
  getMe: vi.fn().mockResolvedValue(null),
  getDevices: vi.fn().mockResolvedValue({ devices: [] }),
  setTokenGetter: vi.fn(),
  requestOtp: vi.fn().mockResolvedValue({ code: 'TEST-OTP' }),
  getWsTicket: vi.fn().mockResolvedValue({ ticket: 'test-ticket' }),
  RELAY_API_BASE: '/api/sm-relay',
  RELAY_WSS_URL: 'wss://bilko.run/projects/session-manager/relay',
}));

// WebSocket relay: prevent real connections; track instantiation.
vi.mock('../ws', () => ({
  RelaySocket: RelaySocketMock,
}));

// Stub deep components to avoid rendering their own effects/imports.
vi.mock('../components/Cockpit', () => ({
  default: () => <div data-testid="cockpit" />,
}));

vi.mock('../components/ConnectScreen', () => ({
  default: () => <div data-testid="connect-screen" />,
}));

import App from '../App';
import { useStore } from '../store';

beforeEach(() => {
  clerkState.isSignedIn = false;
  vi.clearAllMocks();
});

describe('Auth gate — signed out', () => {
  it('renders the Clerk sign-in surface', () => {
    render(<App />);
    expect(screen.getByTestId('clerk-sign-in')).toBeInTheDocument();
  });

  it('does not render Cockpit', () => {
    render(<App />);
    expect(screen.queryByTestId('cockpit')).not.toBeInTheDocument();
  });

  it('does not render ConnectScreen', () => {
    render(<App />);
    expect(screen.queryByTestId('connect-screen')).not.toBeInTheDocument();
  });

  it('does not open a relay socket (AppInner is not mounted)', () => {
    render(<App />);
    expect(RelaySocketMock).not.toHaveBeenCalled();
  });
});

describe('Auth gate — signed in', () => {
  beforeEach(() => {
    clerkState.isSignedIn = true;
    useStore.getState().reset();
  });

  it('mounts AppInner — ConnectScreen visible (no device online yet)', () => {
    render(<App />);
    expect(screen.getByTestId('connect-screen')).toBeInTheDocument();
  });

  it('does not show the sign-in surface', () => {
    render(<App />);
    expect(screen.queryByTestId('clerk-sign-in')).not.toBeInTheDocument();
  });

  it('opens the relay socket', () => {
    render(<App />);
    expect(RelaySocketMock).toHaveBeenCalledTimes(1);
  });
});
