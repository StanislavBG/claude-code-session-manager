import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../components/ProjectsScreen', () => ({ default: () => <div>projects-screen</div> }));
vi.mock('../components/SessionsScreen', () => ({ default: () => <div /> }));
vi.mock('../components/SessionScreen', () => ({ default: () => <div /> }));

import Cockpit from '../components/Cockpit';
import { useStore } from '../store';

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ awaitingDesktopConfirm: false, pendingSas: null });
});

describe('awaitingDesktopConfirm store flag', () => {
  it('is true after setPendingSas, survives clearPendingSas, survives goProjects', () => {
    const s = useStore.getState();
    expect(s.awaitingDesktopConfirm).toBe(false);
    s.setPendingSas({ deviceId: 'd1', sas: '123456' });
    expect(useStore.getState().awaitingDesktopConfirm).toBe(true);
    useStore.getState().clearPendingSas();
    expect(useStore.getState().awaitingDesktopConfirm).toBe(true);
    useStore.getState().goProjects();
    expect(useStore.getState().awaitingDesktopConfirm).toBe(true);
  });

  it('reset restores false', () => {
    useStore.getState().setPendingSas({ deviceId: 'd1', sas: '123456' });
    useStore.getState().reset();
    expect(useStore.getState().awaitingDesktopConfirm).toBe(false);
  });
});

describe('Cockpit projects route', () => {
  it('tells the user to confirm on the desktop while awaiting', () => {
    useStore.setState({ awaitingDesktopConfirm: true });
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(screen.getByText(/Waiting for you to confirm/)).toBeInTheDocument();
    expect(screen.queryByText('projects-screen')).toBeNull();
  });

  it('renders the projects screen when not awaiting', () => {
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(screen.getByText('projects-screen')).toBeInTheDocument();
  });
});
