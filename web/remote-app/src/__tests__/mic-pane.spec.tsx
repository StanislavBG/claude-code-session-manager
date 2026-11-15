import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { trackFlow, trackScreen, track } = vi.hoisted(() => ({
  trackFlow: vi.fn(),
  trackScreen: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../telemetry', () => ({ trackFlow, trackScreen, track, APP: 'session-manager' }));

import MicPane from '../components/MicPane';
import { useStore } from '../store';

const PLACEHOLDER = 'Message this session…';

function makeSocket() {
  return {
    sendCommand: vi.fn(async (type: string, _deviceId?: string, _payload?: unknown): Promise<any> => {
      if (type === 'cmd:chat:send') return { payload: { disposition: 'sent' } };
      return { payload: {} };
    }),
  };
}

let socket: ReturnType<typeof makeSocket>;
const renderMic = (props: Partial<React.ComponentProps<typeof MicPane>> = {}) =>
  render(<MicPane socket={socket as any} deviceId="d" target="epic-1" {...props} />);

const textarea = () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
const sendBtn = () => screen.getByLabelText('Send message') as HTMLButtonElement;
const chatSends = () => socket.sendCommand.mock.calls.filter((c: any[]) => c[0] === 'cmd:chat:send');

function mockPointer(fine: boolean) {
  (window as any).matchMedia = vi.fn((q: string) => ({
    matches: q === '(pointer: fine)' && fine,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
}

beforeEach(() => {
  socket = makeSocket();
  trackFlow.mockClear();
  trackScreen.mockClear();
  delete (window as any).SpeechRecognition;
  delete (window as any).webkitSpeechRecognition;
  useStore.getState().reset();
});

afterEach(() => {
  delete (window as any).matchMedia;
  delete (window as any).SpeechRecognition;
});

describe('MicPane composer (criterion 1)', () => {
  it('is a one-row textarea with the session placeholder without speech support', () => {
    renderMic();
    const ta = textarea();
    expect(ta.tagName).toBe('TEXTAREA');
    expect(ta.getAttribute('rows')).toBe('1');
  });

  it('uses the same placeholder with speech support', () => {
    (window as any).SpeechRecognition = class { start() {} stop() {} };
    renderMic();
    expect(textarea().tagName).toBe('TEXTAREA');
  });

  it('grows with content up to a cap, scrolls, and resets after send', async () => {
    renderMic();
    const ta = textarea();
    let sh = 40;
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => sh });
    fireEvent.change(ta, { target: { value: 'a\nb' } });
    expect(ta.style.height).toBe('40px');
    sh = 5000;
    fireEvent.change(ta, { target: { value: 'a\nb\nc\nd\ne\nf\ng\nh\ni' } });
    const capped = parseFloat(ta.style.height);
    expect(capped).toBeGreaterThan(40);
    expect(capped).toBeLessThan(5000);
    expect(ta.className).toContain('overflow-y-auto');
    expect(ta.className).toContain('resize-none');
    sh = 20;
    fireEvent.click(sendBtn());
    await waitFor(() => expect(ta.value).toBe(''));
    expect(ta.style.height).toBe('20px');
  });

  it('keeps inner newlines and trims only the ends', async () => {
    renderMic();
    fireEvent.change(textarea(), { target: { value: '  line one\n\nline two \n ' } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(chatSends()).toHaveLength(1));
    expect(chatSends()[0][2]).toEqual({ tabId: 'epic-1', prompt: 'line one\n\nline two' });
  });
});

describe('MicPane Send button (criterion 2)', () => {
  it('is always rendered, tagged, and disabled while empty', () => {
    renderMic();
    const b = sendBtn();
    expect(b.getAttribute('data-track')).toBe('mic-send');
    expect(b).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: '   \n ' } });
    expect(sendBtn()).toBeDisabled();
    fireEvent.change(textarea(), { target: { value: 'hi' } });
    expect(sendBtn()).not.toBeDisabled();
  });

  it('is disabled while a send is in flight', async () => {
    let resolve!: (v: any) => void;
    socket.sendCommand.mockImplementation(() => new Promise((r) => { resolve = r; }) as any);
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'hi' } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(sendBtn()).toBeDisabled());
    resolve({ payload: { disposition: 'sent' } });
    await waitFor(() => expect(textarea().value).toBe(''));
  });

  it('is disabled when disabledReason is set', () => {
    renderMic({ disabledReason: 'nope' });
    expect(sendBtn()).toBeDisabled();
    expect(textarea()).toBeDisabled();
    expect(screen.getByText('continue')).toBeDisabled();
    expect(screen.getByTestId('mic-disabled-reason').textContent).toBe('nope');
  });
});

describe('MicPane Enter handling (criterion 3)', () => {
  it('sends on Enter with a fine pointer', async () => {
    mockPointer(true);
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    const ev = fireEvent.keyDown(textarea(), { key: 'Enter' });
    expect(ev).toBe(false); // default prevented
    await waitFor(() => expect(chatSends()).toHaveLength(1));
  });

  it('Shift+Enter never sends', () => {
    mockPointer(true);
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    expect(fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(chatSends()).toHaveLength(0);
  });

  it('Enter inserts a newline on touch devices', () => {
    mockPointer(false);
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    expect(fireEvent.keyDown(textarea(), { key: 'Enter' })).toBe(true);
    expect(chatSends()).toHaveLength(0);
  });

  it('Enter inserts a newline when matchMedia is missing', () => {
    delete (window as any).matchMedia;
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    expect(fireEvent.keyDown(textarea(), { key: 'Enter' })).toBe(true);
    expect(chatSends()).toHaveLength(0);
  });

  it('Enter inserts a newline when matchMedia throws', () => {
    (window as any).matchMedia = vi.fn(() => { throw new Error('x'); });
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    expect(fireEvent.keyDown(textarea(), { key: 'Enter' })).toBe(true);
    expect(chatSends()).toHaveLength(0);
  });

  it('Enter never sends while composing (IME)', () => {
    mockPointer(true);
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'go' } });
    fireEvent.keyDown(textarea(), { key: 'Enter', isComposing: true });
    expect(chatSends()).toHaveLength(0);
  });
});

describe('MicPane chips (criterion 4)', () => {
  it('fills an empty composer and does not send', () => {
    renderMic();
    fireEvent.click(screen.getByText('continue'));
    expect(textarea().value).toBe('continue');
    expect(chatSends()).toHaveLength(0);
    expect(trackFlow).not.toHaveBeenCalled();
  });

  it('appends to existing text with one space', () => {
    renderMic();
    fireEvent.change(textarea(), { target: { value: 'please' } });
    fireEvent.click(screen.getByText('commit'));
    expect(textarea().value).toBe('please commit');
    expect(chatSends()).toHaveLength(0);
  });

  it('reports source chip when sent unedited, without message text', async () => {
    renderMic();
    fireEvent.click(screen.getByText('run the tests'));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(trackFlow).toHaveBeenCalledWith('chat-send', 'success', { source: 'chip' }));
    expect(trackFlow).toHaveBeenCalledWith('chat-send', 'start', { source: 'chip' });
    expect(chatSends()[0][2]).toEqual({ tabId: 'epic-1', prompt: 'run the tests' });
    expect(JSON.stringify(trackFlow.mock.calls)).not.toContain('run the tests');
  });

  it('reports source text after an edit following the chip tap', async () => {
    renderMic();
    fireEvent.click(screen.getByText('continue'));
    fireEvent.change(textarea(), { target: { value: 'continue now' } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(trackFlow).toHaveBeenCalledWith('chat-send', 'success', { source: 'text' }));
    expect(trackFlow).toHaveBeenCalledWith('chat-send', 'start', { source: 'text' });
    expect(JSON.stringify(trackFlow.mock.calls)).not.toContain('continue');
  });
});
