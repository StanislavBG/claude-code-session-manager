import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import SessionNav from '../components/SessionNav';
import MicPane from '../components/MicPane';
import { useStore } from '../store';
import type { SessionMeta } from '../types';

const SESSIONS: SessionMeta[] = [
  { kind: 'project', tabId: 'tab-proj', cwd: '/home/me/alpha', title: 'alpha', project: 'alpha' },
  { kind: 'epic', tabId: 'claude-sess-1', epicId: 'epic-1', cwd: '/wt/1', title: 'Fix login', project: 'alpha', tag: 'bugfix', agentType: 'dev-lead' },
  { kind: 'epic', tabId: 'claude-sess-2', epicId: 'epic-2', cwd: '/wt/2', title: 'Add search', project: 'alpha', tag: 'feature', agentType: 'dev-lead' },
];

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ sessions: SESSIONS, selectedTabId: null, navOpen: true });
});

describe('SessionNav grouping', () => {
  it('renders one project group with Main and both Epic titles', () => {
    render(<SessionNav />);
    expect(screen.getAllByText('alpha')).toHaveLength(1);
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Fix login')).toBeInTheDocument();
    expect(screen.getByText('Add search')).toBeInTheDocument();
    expect(screen.getByText('bugfix')).toBeInTheDocument();
  });
});

describe('MicPane cmd:chat:send', () => {
  const send = async (tabId: string) => {
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    render(<MicPane socket={{ sendCommand } as any} deviceId="dev1" tabId={tabId} />);
    fireEvent.change(screen.getByPlaceholderText(/Type a command|Message this session/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send command'));
    await waitFor(() => expect(sendCommand).toHaveBeenCalled());
    return sendCommand;
  };

  it('sends the epicId for an Epic', async () => {
    const sendCommand = await send('claude-sess-1');
    expect(sendCommand).toHaveBeenCalledWith('cmd:chat:send', 'dev1', { tabId: 'epic-1', prompt: 'hi' });
  });

  it('sends the project tabId for a project', async () => {
    const sendCommand = await send('tab-proj');
    expect(sendCommand).toHaveBeenCalledWith('cmd:chat:send', 'dev1', { tabId: 'tab-proj', prompt: 'hi' });
  });

  it('errors and sends nothing when the session is gone', async () => {
    const sendCommand = vi.fn();
    render(<MicPane socket={{ sendCommand } as any} deviceId="dev1" tabId="gone" />);
    fireEvent.change(screen.getByPlaceholderText(/Type a command|Message this session/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByLabelText('Send command'));
    expect(await screen.findByText('Session no longer available')).toBeInTheDocument();
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
