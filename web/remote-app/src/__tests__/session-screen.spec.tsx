import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import SessionScreen from '../components/SessionScreen';
import { useStore } from '../store';
import type { RemoteSession } from '../types';

const EPIC: RemoteSession = {
  epicId: 'epic-1', claudeSessionId: 'claude-1', title: 'Fix login', status: 'active',
  spawnCwd: '/wt/1', updatedAt: 1,
};

function makeSocket(overrides: Record<string, (p: any) => any> = {}) {
  const sendCommand = vi.fn(async (type: string, _d: string, payload: any) => {
    if (overrides[type]) return overrides[type](payload);
    if (type === 'cmd:session:transcript') {
      return { payload: { messages: [
        { role: 'user', text: 'hello\nthere', ts: 1, uuid: 'a' },
        { role: 'assistant', text: 'hi back', ts: 2, uuid: 'b' },
      ] } };
    }
    if (type === 'cmd:session:prds') return { payload: { prds: [{ slug: 'p1', title: 'First PRD', status: 'done' }] } };
    return { payload: {} };
  });
  return { sendCommand };
}

const renderScreen = (socket: any, session: RemoteSession = EPIC) =>
  render(
    <SessionScreen socket={socket} deviceId="dev1" projectCwd="/home/me/alpha"
      target={{ kind: 'epic', session }} onBack={() => {}} />,
  );

beforeEach(() => { useStore.getState().reset(); });

describe('SessionScreen', () => {
  it('renders transcript bubbles oldest-first', async () => {
    renderScreen(makeSocket());
    const msgs = await screen.findAllByTestId('chat-message');
    expect(msgs.map((m) => m.textContent)).toEqual(['hello\nthere', 'hi back']);
  });

  it('lists PRDs for an epic', async () => {
    renderScreen(makeSocket());
    fireEvent.click(await screen.findByText('PRDs (1)'));
    expect(screen.getByText('First PRD')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });

  it('subscribes on mount and unsubscribes on unmount', async () => {
    const socket = makeSocket();
    const { unmount } = renderScreen(socket);
    await waitFor(() => expect(socket.sendCommand).toHaveBeenCalledWith(
      'cmd:session:subscribe', 'dev1', { tabId: 'claude-1', cwd: '/wt/1' }));
    unmount();
    expect(socket.sendCommand).toHaveBeenCalledWith('cmd:session:unsubscribe', 'dev1', { tabId: 'claude-1' });
  });

  it('sends with epicId as target', async () => {
    const socket = makeSocket();
    renderScreen(socket);
    fireEvent.change(screen.getByPlaceholderText(/Type a command|Message this session/), { target: { value: 'go' } });
    fireEvent.click(screen.getByLabelText('Send command'));
    await waitFor(() => expect(socket.sendCommand).toHaveBeenCalledWith(
      'cmd:chat:send', 'dev1', { tabId: 'epic-1', prompt: 'go' }));
  });

  it('shows the error when a send is refused', async () => {
    const socket = makeSocket({ 'cmd:chat:send': () => ({ payload: { error: 'nope' } }) });
    renderScreen(socket);
    fireEvent.change(screen.getByPlaceholderText(/Type a command|Message this session/), { target: { value: 'go' } });
    fireEvent.click(screen.getByLabelText('Send command'));
    expect(await screen.findByText(/refused this request/)).toBeInTheDocument();
  });

  it('disables the composer for a proposed session', async () => {
    renderScreen(makeSocket(), { ...EPIC, status: 'proposed' });
    expect(screen.getByText('This session is proposed — approve it on your computer first.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Type a command|Message this session/)).toBeDisabled();
    expect(screen.getByText('continue')).toBeDisabled();
  });
});
