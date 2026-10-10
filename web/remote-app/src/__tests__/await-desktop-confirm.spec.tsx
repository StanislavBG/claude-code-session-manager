import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../components/SessionNav', () => ({ default: () => <div /> }));
vi.mock('../components/StatePane', () => ({ default: () => <div /> }));
vi.mock('../components/SummaryPane', () => ({ default: () => <div /> }));
vi.mock('../components/MicPane', () => ({ default: () => <div /> }));

import Cockpit from '../components/Cockpit';
import { useStore } from '../store';

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ awaitingDesktopConfirm: false, pendingSas: null });
});

describe('awaitingDesktopConfirm store flag', () => {
  it('is true after setPendingSas, survives clearPendingSas, clears on setSessions', () => {
    const s = useStore.getState();
    expect(s.awaitingDesktopConfirm).toBe(false);
    s.setPendingSas({ deviceId: 'd1', sas: '123456' });
    expect(useStore.getState().awaitingDesktopConfirm).toBe(true);
    useStore.getState().clearPendingSas();
    expect(useStore.getState().awaitingDesktopConfirm).toBe(true);
    useStore.getState().setSessions([]);
    expect(useStore.getState().awaitingDesktopConfirm).toBe(false);
  });

  it('reset restores false', () => {
    useStore.getState().setPendingSas({ deviceId: 'd1', sas: '123456' });
    useStore.getState().reset();
    expect(useStore.getState().awaitingDesktopConfirm).toBe(false);
  });
});

describe('Cockpit empty state', () => {
  it('tells the user to confirm on the desktop while awaiting', () => {
    useStore.setState({ awaitingDesktopConfirm: true, sessions: [], selectedTabId: null });
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(screen.getByText(/Waiting for you to confirm/)).toBeInTheDocument();
    expect(screen.queryByText(/No active sessions/)).toBeNull();
  });

  it('keeps the default empty text when not awaiting', () => {
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(screen.getByText('No active sessions on this device yet.')).toBeInTheDocument();
  });
});
