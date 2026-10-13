import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { listProjectSessions } = vi.hoisted(() => ({ listProjectSessions: vi.fn() }));
vi.mock('../remoteApi', () => ({ listProjectSessions }));
vi.mock('../components/NewSessionSheet', () => ({
  default: ({ onStarted, cwd }: any) => (
    <button data-testid="sheet" data-cwd={cwd} onClick={onStarted}>
      sheet
    </button>
  ),
}));

import SessionsScreen from '../components/SessionsScreen';

const mk = (epicId: string, status: string, extra: any = {}) => ({
  epicId,
  claudeSessionId: `c-${epicId}`,
  title: `T-${epicId}`,
  status,
  tag: 'feature',
  agentType: 'dev-lead',
  spawnCwd: '/p/alpha',
  updatedAt: 1,
  ...extra,
});
const PROJECT = { cwd: '/p/alpha', title: 'alpha', mainTabId: 'main-1', counts: { proposed: 0, active: 0, completed: 0 } };

function setup(sessions: any[]) {
  listProjectSessions.mockResolvedValue({ project: PROJECT, sessions });
  const props = { onBack: vi.fn(), onOpen: vi.fn() };
  render(<SessionsScreen socket={{} as any} deviceId="dev1" cwd="/p/alpha" refreshKey={0} {...props} />);
  return props;
}

beforeEach(() => listProjectSessions.mockReset());

describe('SessionsScreen', () => {
  it('groups rows into Active, Proposed, Completed in order', async () => {
    setup([mk('c1', 'completed'), mk('p1', 'proposed'), mk('a1', 'active'), mk('a2', 'active')]);
    await screen.findByTestId('main-session-row');
    expect(listProjectSessions).toHaveBeenCalledWith({}, 'dev1', '/p/alpha');
    const sections = screen.getAllByRole('region').map((s) => s.getAttribute('aria-label'));
    expect(sections).toEqual(['Active', 'Proposed', 'Completed']);
    const active = within(screen.getByRole('region', { name: 'Active' })).getAllByTestId('session-row');
    expect(active.map((r) => r.textContent)).toEqual([
      expect.stringContaining('T-a1'),
      expect.stringContaining('T-a2'),
    ]);
    expect(active[0]!.textContent).toContain('feature · dev-lead');
  });

  it('hides empty sections', async () => {
    setup([mk('a1', 'active')]);
    await screen.findByTestId('session-row');
    expect(screen.queryByRole('region', { name: 'Proposed' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Completed' })).toBeNull();
  });

  it('shows empty state', async () => {
    setup([]);
    expect(await screen.findByText('No sessions in this project yet.')).toBeInTheDocument();
  });

  it('tapping epic and Main call onOpen with the right shape', async () => {
    const { onOpen } = setup([mk('a1', 'active')]);
    fireEvent.click(await screen.findByTestId('session-row'));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'epic', session: mk('a1', 'active') });
    fireEvent.click(screen.getByTestId('main-session-row'));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'main', mainTabId: 'main-1', title: 'alpha' });
  });

  it('Back calls onBack', async () => {
    const { onBack } = setup([]);
    await screen.findByTestId('main-session-row');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows error and Retry refetches', async () => {
    listProjectSessions.mockRejectedValueOnce(new Error('boom'));
    listProjectSessions.mockResolvedValueOnce({ project: PROJECT, sessions: [mk('a1', 'active')] });
    render(<SessionsScreen socket={{} as any} deviceId="dev1" cwd="/p/alpha" refreshKey={0} onBack={vi.fn()} onOpen={vi.fn()} />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    expect(await screen.findByTestId('session-row')).toBeInTheDocument();
    expect(listProjectSessions).toHaveBeenCalledTimes(2);
  });

  it('refetches 1500ms after a session is started', async () => {
    setup([]);
    await screen.findByTestId('main-session-row');
    fireEvent.click(screen.getByText('+ New session'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('sheet'));
    expect(listProjectSessions).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    vi.useRealTimers();
    await waitFor(() => expect(listProjectSessions).toHaveBeenCalledTimes(2));
  });
});
