import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { trackFlow, trackScreen, track } = vi.hoisted(() => ({
  trackFlow: vi.fn(),
  trackScreen: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../telemetry', () => ({ trackFlow, trackScreen, track, APP: 'session-manager' }));

const { listProjectSessions } = vi.hoisted(() => ({ listProjectSessions: vi.fn() }));
vi.mock('../remoteApi', () => ({
  listProjectSessions,
  getTranscript: vi.fn(async () => ({ messages: [] })),
  listSessionPrds: vi.fn(async () => ({ prds: [] })),
}));

import SessionsScreen from '../components/SessionsScreen';
import NewSessionSheet from '../components/NewSessionSheet';
import SessionScreen from '../components/SessionScreen';
import { useStore } from '../store';

const OPTIONS = {
  agents: [{ name: 'dev-lead' }],
  tags: ['feature'],
  macros: [{ id: 'm1', label: 'Build it', agentName: 'dev-lead', tag: 'feature', prompt: 'Build', projects: ['*'] }],
};

function sheet(createImpl: () => Promise<any>) {
  const sendCommand = vi.fn((type: string) =>
    type === 'cmd:session:options' ? Promise.resolve({ payload: OPTIONS }) : createImpl(),
  );
  render(<NewSessionSheet socket={{ sendCommand } as any} deviceId="d" cwd="/p/a" project="a" onClose={() => {}} />);
}

async function submit() {
  fireEvent.click(await screen.findByText('Build it'));
  fireEvent.click(screen.getByText('Start'));
}

beforeEach(() => {
  trackFlow.mockClear();
  trackScreen.mockClear();
  useStore.getState().reset();
});

describe('telemetry: sessions', () => {
  it('tags SessionsScreen buttons', async () => {
    listProjectSessions.mockResolvedValue({
      project: { cwd: '/p/a', title: 'a', mainTabId: 'm', counts: {} },
      sessions: [{ epicId: 'e1', claudeSessionId: 'c1', title: 'T', status: 'active', updatedAt: 1 }],
    });
    render(<SessionsScreen socket={{} as any} deviceId="d" cwd="/p/a" refreshKey={0} onBack={() => {}} onOpen={() => {}} />);
    const main = await screen.findByTestId('main-session-row');
    expect(main).toHaveAttribute('data-track', 'sessions-open-main');
    expect(main).toHaveAttribute('data-track-redact');
    const row = screen.getByTestId('session-row');
    expect(row).toHaveAttribute('data-track', 'sessions-open-epic');
    expect(row).toHaveAttribute('data-track-redact');
    expect(screen.getByLabelText('Back')).toHaveAttribute('data-track', 'sessions-back');
    expect(screen.getByLabelText('New session in a')).toHaveAttribute('data-track', 'sessions-new');
  });

  it('tags the retry button', async () => {
    listProjectSessions.mockRejectedValue(new Error('boom'));
    render(<SessionsScreen socket={{} as any} deviceId="d" cwd="/p/a" refreshKey={0} onBack={() => {}} onOpen={() => {}} />);
    expect(await screen.findByText('Retry')).toHaveAttribute('data-track', 'sessions-retry');
  });

  it('tags sheet buttons and emits start on mount', async () => {
    sheet(() => Promise.resolve({ payload: {} }));
    expect(trackScreen).toHaveBeenCalledWith('new-session-sheet');
    expect(trackFlow).toHaveBeenCalledWith('new-session', 'start');
    const macro = await screen.findByText('Build it');
    expect(macro).toHaveAttribute('data-track', 'new-session-macro');
    expect(macro).toHaveAttribute('data-track-redact');
    expect(screen.getByLabelText('Close')).toHaveAttribute('data-track', 'new-session-close');
    expect(screen.getByLabelText('Dictate prompt')).toHaveAttribute('data-track', 'new-session-dictate');
    expect(screen.getByText('Start')).toHaveAttribute('data-track', 'new-session-start');
  });

  it('emits submit + success with tag only', async () => {
    sheet(() => Promise.resolve({ payload: { ok: true } }));
    await submit();
    await waitFor(() => expect(trackFlow).toHaveBeenCalledWith('new-session', 'success', { tag: 'feature' }));
    expect(trackFlow).toHaveBeenCalledWith('new-session', 'submit', { tag: 'feature' });
  });

  it('emits fail desktop-error', async () => {
    sheet(() => Promise.resolve({ payload: { error: 'nope' } }));
    await submit();
    await waitFor(() =>
      expect(trackFlow).toHaveBeenCalledWith('new-session', 'fail', { tag: 'feature', reason: 'desktop-error' }),
    );
  });

  it('emits fail send-error', async () => {
    sheet(() => Promise.reject(new Error('down')));
    await submit();
    await waitFor(() =>
      expect(trackFlow).toHaveBeenCalledWith('new-session', 'fail', { tag: 'feature', reason: 'send-error' }),
    );
  });

  it('tags SessionScreen buttons', async () => {
    const sendCommand = vi.fn(async () => ({ payload: {} }));
    render(
      <SessionScreen
        socket={{ sendCommand } as any}
        deviceId="d"
        projectCwd="/p/a"
        target={{ kind: 'epic', session: { epicId: 'e', claudeSessionId: 'c', title: 'T', status: 'active', spawnCwd: '/w', updatedAt: 1 } }}
        onBack={() => {}}
      />,
    );
    expect(screen.getByLabelText('Back')).toHaveAttribute('data-track', 'session-back');
    expect(await screen.findByText(/PRDs \(/)).toHaveAttribute('data-track', 'session-prds-toggle');
  });
});
