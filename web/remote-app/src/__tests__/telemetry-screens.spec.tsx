import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

const { handlers } = vi.hoisted(() => ({ handlers: {} as Record<string, (m: unknown) => void> }));

vi.mock('../telemetry', () => ({ trackScreen: vi.fn(), trackFlow: vi.fn(), track: vi.fn() }));

vi.mock('@clerk/clerk-react', () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedIn: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SignedOut: () => null,
  SignIn: () => null,
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue('t') }),
}));
vi.mock('../api', () => ({
  getMe: vi.fn().mockResolvedValue(null),
  getDevices: vi.fn().mockResolvedValue({ devices: [] }),
  setTokenGetter: vi.fn(),
}));
vi.mock('../ws', () => ({
  RelaySocket: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((name: string, fn: (m: unknown) => void) => { handlers[name] = fn; return () => {}; }),
    destroy: vi.fn(),
    initiateE2E: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../components/ConnectScreen', () => ({ default: () => <div>connect-screen</div> }));
vi.mock('../components/ProjectsScreen', () => ({
  default: ({ onOpen }: { onOpen: (p: unknown) => void }) => (
    <button onClick={() => onOpen({ cwd: '/p/a', title: 'Alpha', mainTabId: 'm1', counts: {} })}>projects-screen</button>
  ),
}));
vi.mock('../components/SessionsScreen', () => ({
  default: ({ cwd, onOpen }: { cwd: string; onOpen: (t: unknown) => void }) => (
    <button onClick={() => onOpen({ kind: 'main', mainTabId: 'm1', title: 'Alpha main' })}>sessions-screen {cwd}</button>
  ),
}));
vi.mock('../components/SessionScreen', () => ({
  default: ({ projectCwd }: { projectCwd: string }) => <div>session-screen {projectCwd}</div>,
}));

import Cockpit from '../components/Cockpit';
import App from '../App';
import { useStore } from '../store';
import { trackScreen, trackFlow } from '../telemetry';

const screens = () => vi.mocked(trackScreen).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  useStore.getState().reset();
  useStore.setState({ awaitingDesktopConfirm: false, pendingSas: null });
});

describe('Cockpit screen telemetry', () => {
  it('emits projects → sessions → session → back sessions, deduped', async () => {
    render(<Cockpit socket={null} deviceId="d1" />);
    fireEvent.click(screen.getByText('projects-screen'));
    fireEvent.click(screen.getByText(/sessions-screen/));
    window.history.back();
    await waitFor(() => expect(useStore.getState().route.view).toBe('sessions'));
    expect(screens()).toEqual(['projects', 'sessions', 'session', 'sessions']);
    expect(JSON.stringify(vi.mocked(trackScreen).mock.calls)).not.toContain('Alpha');
  });

  it('emits awaiting-desktop while waiting on the projects view', () => {
    useStore.setState({ awaitingDesktopConfirm: true });
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(screens()).toEqual(['awaiting-desktop']);
  });
});

describe('App telemetry', () => {
  it('tracks connect, sas-confirm, sas-dismiss attr and pair success', async () => {
    render(<App />);
    expect(screens()).toContain('connect');
    act(() => { useStore.setState({ pendingSas: { deviceId: 'd1', sas: '123456' } }); });
    expect(screens()).toContain('sas-confirm');
    expect(screen.getByText('Got it')).toHaveAttribute('data-track', 'sas-dismiss');

    expect(trackFlow).not.toHaveBeenCalled();
    act(() => { handlers['event:remote:ready']({ deviceId: undefined }); });
    expect(trackFlow).toHaveBeenCalledTimes(1);
    expect(trackFlow).toHaveBeenCalledWith('pair', 'success');
  });

  it('tracks pair resumed (not success) when no SAS was pending', () => {
    render(<App />);
    act(() => { handlers['event:remote:ready']({ deviceId: undefined }); });
    expect(trackFlow).toHaveBeenCalledTimes(1);
    expect(trackFlow).toHaveBeenCalledWith('pair', 'resumed');
    expect(trackFlow).not.toHaveBeenCalledWith('pair', 'success');
  });
});
