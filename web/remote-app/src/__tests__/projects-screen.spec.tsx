import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../remoteApi', async () => {
  const actual = await vi.importActual<typeof import('../remoteApi')>('../remoteApi');
  return { ...actual, listProjects: vi.fn() };
});

import { listProjects, RemoteError } from '../remoteApi';
import ProjectsScreen from '../components/ProjectsScreen';

const mocked = vi.mocked(listProjects);

const PROJECTS = [
  { cwd: '/p/alpha', title: 'Alpha', mainTabId: 't1', counts: { active: 2, proposed: 1, completed: 5 } },
  { cwd: '/p/beta', title: 'Beta', mainTabId: 't2', counts: { active: 0, proposed: 3, completed: 0 } },
];

const socket = { sendCommand: vi.fn() } as any;

function renderScreen(refreshKey = 0, onOpen = vi.fn()) {
  const ui = (k: number) => (
    <ProjectsScreen socket={socket} deviceId="dev1" refreshKey={k} onOpen={onOpen} />
  );
  const r = render(ui(refreshKey));
  return { onOpen, rerender: (k: number) => r.rerender(ui(k)) };
}

describe('ProjectsScreen', () => {
  beforeEach(() => mocked.mockReset());

  it('renders a row per project with counts', async () => {
    mocked.mockResolvedValue({ projects: PROJECTS });
    renderScreen();
    const rows = await screen.findAllByTestId('project-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Alpha');
    expect(rows[0]).toHaveTextContent('alpha');
    expect(rows[0]).toHaveTextContent('2 active · 1 proposed');
    expect(rows[1]).toHaveTextContent('0 active · 3 proposed');
    expect(mocked).toHaveBeenCalledWith(socket, 'dev1');
  });

  it('tap calls onOpen with the project', async () => {
    mocked.mockResolvedValue({ projects: PROJECTS });
    const { onOpen } = renderScreen();
    fireEvent.click((await screen.findAllByTestId('project-row'))[1]);
    expect(onOpen).toHaveBeenCalledWith(PROJECTS[1]);
  });

  it('shows the empty state', async () => {
    mocked.mockResolvedValue({ projects: [] });
    renderScreen();
    expect(
      await screen.findByText('No projects open in Session Manager on your computer.'),
    ).toBeInTheDocument();
  });

  it('shows the error and Retry refetches', async () => {
    mocked.mockRejectedValueOnce(new RemoteError('relay down'));
    renderScreen();
    expect(await screen.findByText('relay down')).toBeInTheDocument();
    mocked.mockResolvedValue({ projects: PROJECTS });
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findAllByTestId('project-row')).toHaveLength(2);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it('refetches when refreshKey changes', async () => {
    mocked.mockResolvedValue({ projects: PROJECTS });
    const { rerender } = renderScreen(0);
    await screen.findAllByTestId('project-row');
    rerender(1);
    await waitFor(() => expect(mocked).toHaveBeenCalledTimes(2));
  });
});
