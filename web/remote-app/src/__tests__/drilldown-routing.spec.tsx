import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
import { useStore } from '../store';

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ awaitingDesktopConfirm: false, pendingSas: null });
});

describe('drill-down routing', () => {
  it('projects → sessions → session → back → back', async () => {
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(screen.getByText('Session Manager')).toBeInTheDocument();

    fireEvent.click(screen.getByText('projects-screen'));
    expect(useStore.getState().route.view).toBe('sessions');
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/sessions-screen/));
    expect(useStore.getState().route.view).toBe('session');
    expect(screen.getByText('session-screen /p/a')).toBeInTheDocument();
    expect(screen.getByText('Alpha main')).toBeInTheDocument();

    window.history.back();
    await waitFor(() => expect(useStore.getState().route.view).toBe('sessions'));
    window.history.back();
    await waitFor(() => expect(useStore.getState().route.view).toBe('projects'));
    expect(screen.getByText('Session Manager')).toBeInTheDocument();
  });
});
