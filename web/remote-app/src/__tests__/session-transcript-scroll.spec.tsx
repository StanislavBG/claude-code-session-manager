import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import SessionScreen from '../components/SessionScreen';
import { useStore } from '../store';
import type { ChatMessage, RemoteSession } from '../types';

const EPIC: RemoteSession = {
  epicId: 'epic-1', claudeSessionId: 'claude-1', title: 'Fix login', status: 'active',
  spawnCwd: '/wt/1', updatedAt: 1,
};

const ROW = 100;
const VIEW = 300;

const msg = (n: number, role: ChatMessage['role'] = 'assistant'): ChatMessage =>
  ({ role, text: `m${n}`, ts: n, uuid: `u${n}` } as ChatMessage);

type Page = { messages: ChatMessage[]; hasMore?: boolean; nextBefore?: number };

/** A socket whose newest-page and older-page transcript responses the test swaps between updates. */
function makeSocket(state: { newest: Page; older?: Page }) {
  const sendCommand = vi.fn(async (type: string, _d: string, payload: any) => {
    if (type === 'cmd:session:transcript') {
      return { payload: payload.before !== undefined ? state.older ?? { messages: [] } : state.newest };
    }
    if (type === 'cmd:session:prds') return { payload: { prds: [] } };
    if (type === 'cmd:chat:send') return { payload: { disposition: 'sent' } };
    return { payload: {} };
  });
  return { sendCommand };
}

const renderScreen = (socket: any) =>
  render(
    <SessionScreen socket={socket} deviceId="dev1" projectCwd="/home/me/alpha"
      target={{ kind: 'epic', session: EPIC }} onBack={() => {}} />,
  );

/** jsdom does no layout: give the transcript a scrollHeight of ROW px per bubble, a fixed clientHeight and a writable scrollTop. */
function fakeLayout() {
  const el = screen.getByTestId('transcript');
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => el.querySelectorAll('[data-testid="chat-message"],[data-testid="pending-message"]').length * ROW,
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEW });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
  return el;
}

const bubbles = () => screen.queryAllByTestId('chat-message').length;

/** Reader scrolls the transcript to `top` (fires the scroll event the component tracks). */
function scrollTo(el: HTMLElement, top: number) {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

beforeEach(() => { useStore.getState().reset(); });

describe('SessionScreen transcript scroll', () => {
  it('opens scrolled to the newest message on first load', async () => {
    const state = { newest: { messages: [1, 2, 3, 4, 5, 6].map((n) => msg(n)) } };
    renderScreen(makeSocket(state));
    const el = fakeLayout();
    await waitFor(() => expect(bubbles()).toBe(6));
    expect(el.scrollTop).toBe(600);
  });

  it('follows new messages when the reader is within 80px of the bottom', async () => {
    const state = { newest: { messages: [1, 2, 3, 4, 5, 6].map((n) => msg(n)) } };
    renderScreen(makeSocket(state));
    const el = fakeLayout();
    await waitFor(() => expect(bubbles()).toBe(6));
    // 600 - 250 - 300 = 50px from the bottom: still counts as at the bottom.
    scrollTo(el, 250);
    state.newest = { messages: [1, 2, 3, 4, 5, 6, 7].map((n) => msg(n)) };
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(bubbles()).toBe(7));
    expect(el.scrollTop).toBe(700);
  });

  it('leaves scrollTop alone when the reader has scrolled up', async () => {
    const state = { newest: { messages: [1, 2, 3, 4, 5, 6].map((n) => msg(n)) } };
    renderScreen(makeSocket(state));
    const el = fakeLayout();
    await waitFor(() => expect(bubbles()).toBe(6));
    // 600 - 100 - 300 = 200px from the bottom.
    scrollTo(el, 100);
    state.newest = { messages: [1, 2, 3, 4, 5, 6, 7].map((n) => msg(n)) };
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(bubbles()).toBe(7));
    expect(el.scrollTop).toBe(100);
  });

  it("scrolls to the bottom after the user's own send even when scrolled up", async () => {
    const state = { newest: { messages: [1, 2, 3, 4, 5, 6].map((n) => msg(n)) } };
    renderScreen(makeSocket(state));
    const el = fakeLayout();
    await waitFor(() => expect(bubbles()).toBe(6));
    scrollTo(el, 0);
    fireEvent.change(screen.getByPlaceholderText('Message this session…'), { target: { value: 'go' } });
    fireEvent.click(screen.getByLabelText('Send message'));
    await screen.findByTestId('pending-message');
    expect(el.scrollTop).toBe(700);
  });

  it('keeps the first on-screen message in place when Load earlier prepends', async () => {
    const state: { newest: Page; older?: Page } = {
      newest: { messages: [3, 4, 5, 6].map((n) => msg(n)), hasMore: true, nextBefore: 3 },
      older: { messages: [1, 2].map((n) => msg(n)), hasMore: false },
    };
    renderScreen(makeSocket(state));
    const el = fakeLayout();
    await waitFor(() => expect(bubbles()).toBe(4));
    scrollTo(el, 0);
    fireEvent.click(screen.getByText('Load earlier'));
    await waitFor(() => expect(bubbles()).toBe(6));
    // Two older bubbles added 200px above the reader.
    expect(el.scrollTop).toBe(200);
  });
});
