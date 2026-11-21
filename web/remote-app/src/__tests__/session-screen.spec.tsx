import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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
      ], hasMore: false } };
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
    fireEvent.change(screen.getByPlaceholderText('Message this session…'), { target: { value: 'go' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await waitFor(() => expect(socket.sendCommand).toHaveBeenCalledWith(
      'cmd:chat:send', 'dev1', { tabId: 'epic-1', prompt: 'go' }));
  });

  it('shows the error when a send is refused', async () => {
    const socket = makeSocket({ 'cmd:chat:send': () => ({ payload: { error: 'nope' } }) });
    renderScreen(socket);
    fireEvent.change(screen.getByPlaceholderText('Message this session…'), { target: { value: 'go' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    expect(await screen.findByText(/refused this request/)).toBeInTheDocument();
  });

  it('disables the composer for a proposed session', async () => {
    renderScreen(makeSocket(), { ...EPIC, status: 'proposed' });
    expect(screen.getByText('This session is proposed — approve it on your computer first.')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message this session…')).toBeDisabled();
    expect(screen.getByText('continue')).toBeDisabled();
  });

  it('does not render a summary pane', async () => {
    renderScreen(makeSocket());
    await screen.findAllByTestId('chat-message');
    expect(screen.queryByTestId('summary-pane')).toBeNull();
    expect(screen.queryByText(/Show raw message/)).toBeNull();
  });

  it('Load earlier prepends older messages without duplicating uuids', async () => {
    const socket = makeSocket({
      'cmd:session:transcript': (p: any) => p.before === 5
        ? { payload: { messages: [
          { role: 'user', text: 'old', ts: 0, uuid: 'z' },
          { role: 'assistant', text: 'hi back', ts: 2, uuid: 'b' },
        ], hasMore: false } }
        : { payload: { messages: [
          { role: 'assistant', text: 'hi back', ts: 2, uuid: 'b' },
          { role: 'user', text: 'new', ts: 3, uuid: 'c' },
        ], hasMore: true, nextBefore: 5 } },
    });
    renderScreen(socket);
    fireEvent.click(await screen.findByText('Load earlier'));
    await waitFor(() => expect(screen.getAllByTestId('chat-message').map((m) => m.textContent)).toEqual(['old', 'hi back', 'new']));
    expect(socket.sendCommand).toHaveBeenCalledWith('cmd:session:transcript', 'dev1',
      expect.objectContaining({ before: 5 }));
    expect(screen.queryByText('Load earlier')).toBeNull();
  });

  const send = async (text: string) => {
    fireEvent.change(screen.getByPlaceholderText('Message this session…'), { target: { value: text } });
    fireEvent.click(screen.getByLabelText('Send message'));
  };

  it.each([
    ['queued', 'Queued — another turn is running'],
    ['sent', 'Sent'],
    ['unconfirmed', 'Sent — waiting for your computer to confirm'],
  ])('shows a pending bubble labelled for %s', async (disposition, label) => {
    const socket = makeSocket({ 'cmd:chat:send': () => ({ payload: { disposition } }) });
    renderScreen(socket);
    await screen.findAllByTestId('chat-message');
    await send('do it');
    const bubble = await screen.findByTestId('pending-message');
    expect(bubble).toHaveTextContent('do it');
    expect(screen.getByTestId('pending-label').textContent).toBe(label);
  });

  it('clears the pending bubble once the transcript contains the prompt', async () => {
    let echoed = false;
    const socket = makeSocket({
      'cmd:chat:send': () => ({ payload: { disposition: 'sent' } }),
      'cmd:session:transcript': () => ({ payload: { messages: [
        { role: 'user', text: 'hello', ts: 1, uuid: 'a' },
        ...(echoed ? [{ role: 'user', text: 'please do it now', ts: 2, uuid: 'n' }] : []),
      ], hasMore: false } }),
    });
    renderScreen(socket);
    await screen.findAllByTestId('chat-message');
    await send('do it');
    await screen.findByTestId('pending-message');
    echoed = true;
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).toBeNull());
  });

  it('Refresh re-fetches the newest page', async () => {
    const socket = makeSocket();
    renderScreen(socket);
    await screen.findAllByTestId('chat-message');
    const count = () => socket.sendCommand.mock.calls.filter((c: any[]) => c[0] === 'cmd:session:transcript').length;
    const before = count();
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(count()).toBe(before + 1));
  });

  it('stops polling after 45 ticks per send', async () => {
    const socket = makeSocket({ 'cmd:chat:send': () => ({ payload: { disposition: 'sent' } }) });
    renderScreen(socket);
    await screen.findAllByTestId('chat-message');
    const count = () => socket.sendCommand.mock.calls.filter((c: any[]) => c[0] === 'cmd:session:transcript').length;
    vi.useFakeTimers();
    try {
      await send('never echoed');
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const start = count();
      for (let i = 0; i < 60; i++) await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(count() - start).toBe(45);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('attachments', () => {
    const png = (name = 'shot.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
    const pick = (files: File[]) => fireEvent.change(screen.getByTestId('mic-attach-input'), { target: { files } });
    const enableImages = () => useStore.getState().setDeviceCapabilities('dev1', ['chat-images']);

    it('renders trailing Attached lines as chips with the file name only', async () => {
      const socket = makeSocket({
        'cmd:session:transcript': () => ({ payload: { messages: [
          { role: 'user', text: 'look\n\nAttached: /home/me/.sm/att/abc12345-shot.png\nAttached: /home/me/.sm/att/two.jpg', ts: 1, uuid: 'a' },
          { role: 'assistant', text: 'plain reply', ts: 2, uuid: 'b' },
        ], hasMore: false } }),
      });
      renderScreen(socket);
      const msgs = await screen.findAllByTestId('chat-message');
      const chips = screen.getAllByTestId('message-attachment');
      expect(chips.map((c) => c.textContent)).toEqual(['📎shot.png', '📎two.jpg']);
      expect(msgs[0].textContent).not.toContain('/home/me');
      expect(msgs[0].textContent).toContain('look');
      expect(msgs[1].textContent).toBe('plain reply');
      expect(msgs[1].querySelector('[data-testid="message-attachment"]')).toBeNull();
    });

    it('shows the sent images as thumbnails in the pending bubble', async () => {
      enableImages();
      const socket = makeSocket({ 'cmd:chat:send': () => ({ payload: { disposition: 'sent' } }) });
      renderScreen(socket);
      await screen.findAllByTestId('chat-message');
      pick([png()]);
      await waitFor(() => expect(screen.getByLabelText('Send message')).not.toBeDisabled());
      await send('see this');
      const bubble = await screen.findByTestId('pending-message');
      const img = bubble.querySelector('img') as HTMLImageElement;
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
      expect(img.getAttribute('alt')).toBe('shot.png');
      expect(img.style.maxHeight).toBe('96px');
      expect(bubble).toHaveTextContent('see this');
    });

    it('image-only send: clears once a user message contains a returned attachment path', async () => {
      enableImages();
      let echoed = false;
      const socket = makeSocket({
        'cmd:chat:send': () => ({ payload: { disposition: 'sent', attachments: ['/home/me/.sm/att/abc12345-shot.png'] } }),
        'cmd:session:transcript': () => ({ payload: { messages: [
          { role: 'user', text: 'hello', ts: 1, uuid: 'a' },
          ...(echoed ? [{ role: 'user', text: 'Attached: /home/me/.sm/att/abc12345-shot.png', ts: 3, uuid: 'n' }] : []),
        ], hasMore: false } }),
      });
      renderScreen(socket);
      await screen.findAllByTestId('chat-message');
      pick([png()]);
      await waitFor(() => expect(screen.getByLabelText('Send message')).not.toBeDisabled());
      fireEvent.click(screen.getByLabelText('Send message'));
      await screen.findByTestId('pending-message');
      // An earlier user message must not clear it via an empty-string match.
      fireEvent.click(screen.getByText('Refresh'));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByTestId('pending-message')).toBeInTheDocument();
      echoed = true;
      fireEvent.click(screen.getByText('Refresh'));
      await waitFor(() => expect(screen.queryByTestId('pending-message')).toBeNull());
    });

    it('image-only send: clears once a user message newer than the send appears', async () => {
      enableImages();
      let echoed = false;
      const socket = makeSocket({
        'cmd:chat:send': () => ({ payload: { disposition: 'sent' } }),
        'cmd:session:transcript': () => ({ payload: { messages: [
          { role: 'user', text: 'hello', ts: 1, uuid: 'a' },
          ...(echoed ? [{ role: 'user', text: 'Attached: /elsewhere/img.png', ts: Date.now(), uuid: 'n' }] : []),
        ], hasMore: false } }),
      });
      renderScreen(socket);
      await screen.findAllByTestId('chat-message');
      pick([png()]);
      await waitFor(() => expect(screen.getByLabelText('Send message')).not.toBeDisabled());
      fireEvent.click(screen.getByLabelText('Send message'));
      await screen.findByTestId('pending-message');
      fireEvent.click(screen.getByText('Refresh'));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByTestId('pending-message')).toBeInTheDocument();
      echoed = true;
      fireEvent.click(screen.getByText('Refresh'));
      await waitFor(() => expect(screen.queryByTestId('pending-message')).toBeNull());
    });
  });
});
