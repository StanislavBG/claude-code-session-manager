import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

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

describe('MicPane image attach', () => {
  const CAP_MSG = 'Update Session Manager on your computer to send images from your phone.';
  const png = (name = 'shot.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
  const attachInput = () => screen.getByTestId('mic-attach-input') as HTMLInputElement;
  const pick = (files: File[]) => fireEvent.change(attachInput(), { target: { files } });
  const thumbs = () => screen.queryAllByTestId('mic-attach-thumb');
  const enableImages = () => useStore.getState().setDeviceCapabilities('d', ['chat-images']);

  it('renders the paperclip and hidden picker input', () => {
    enableImages();
    renderMic();
    const btn = screen.getByTestId('mic-attach');
    expect(btn.getAttribute('aria-label')).toBe('Attach images');
    expect(btn.getAttribute('data-track')).toBe('mic-attach');
    const input = attachInput();
    expect(input.type).toBe('file');
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.multiple).toBe(true);
  });

  it('pick → thumbnail → send with text and images', async () => {
    enableImages();
    const onSent = vi.fn();
    renderMic({ onSent });
    pick([png()]);
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    const img = thumbs()[0].querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    fireEvent.change(textarea(), { target: { value: 'look' } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(chatSends()).toHaveLength(1));
    const payload = chatSends()[0][2];
    expect(payload).toEqual({
      tabId: 'epic-1',
      prompt: 'look',
      images: [{ name: 'shot.png', mime: 'image/png', data: btoa(String.fromCharCode(137, 80, 78, 71)) }],
    });
    await waitFor(() => expect(thumbs()).toHaveLength(0));
    expect(onSent).toHaveBeenCalledWith('look', { disposition: 'sent', reason: undefined, attachments: undefined }, [
      { name: 'shot.png', previewUrl: img.getAttribute('src') },
    ]);
  });

  it('image-only send is allowed', async () => {
    enableImages();
    renderMic();
    expect(sendBtn()).toBeDisabled();
    pick([png()]);
    await waitFor(() => expect(sendBtn()).not.toBeDisabled());
    fireEvent.click(sendBtn());
    await waitFor(() => expect(chatSends()).toHaveLength(1));
    expect((chatSends()[0][2] as any).prompt).toBe('');
    expect((chatSends()[0][2] as any).images).toHaveLength(1);
  });

  it('keeps images and text on failure', async () => {
    enableImages();
    socket.sendCommand.mockImplementation(async () => ({ payload: { disposition: 'refused', reason: 'attachment-invalid' } }));
    renderMic();
    pick([png()]);
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    fireEvent.change(textarea(), { target: { value: 'x' } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('could not accept one of the images'));
    expect(thumbs()).toHaveLength(1);
    expect(textarea().value).toBe('x');
  });

  it('remove drops a thumbnail', async () => {
    enableImages();
    renderMic();
    pick([png('a.png'), png('b.png')]);
    await waitFor(() => expect(thumbs()).toHaveLength(2));
    const rm = screen.getAllByLabelText('Remove image');
    expect(rm[0].getAttribute('data-track')).toBe('mic-attach-remove');
    fireEvent.click(rm[0]);
    expect(thumbs()).toHaveLength(1);
    expect(thumbs()[0].querySelector('img')!.getAttribute('alt')).toBe('b.png');
  });

  it('caps at 6 images per message', async () => {
    enableImages();
    renderMic();
    pick(Array.from({ length: 8 }, (_, i) => png(`${i}.png`)));
    await waitFor(() => expect(thumbs()).toHaveLength(6));
    expect(screen.getByRole('alert').textContent).toBe('Up to 6 images per message');
  });

  it('shows the attach error for an unsupported file', async () => {
    enableImages();
    renderMic();
    pick([new File(['hi'], 'notes.txt', { type: 'text/plain' })]);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't attach notes.txt: not an image: text/plain"));
    expect(thumbs()).toHaveLength(0);
  });

  it('paste of a clipboard image adds a thumbnail', async () => {
    enableImages();
    renderMic();
    const f = png('pasted.png');
    fireEvent.paste(textarea(), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => f }], files: [f] },
    });
    await waitFor(() => expect(thumbs()).toHaveLength(1));
  });

  it('without chat-images: paperclip and paste show the update message and open no picker', async () => {
    renderMic();
    const clickSpy = vi.spyOn(attachInput(), 'click');
    fireEvent.click(screen.getByTestId('mic-attach'));
    expect(clickSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(CAP_MSG);
    const f = png();
    fireEvent.paste(textarea(), {
      clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => f }], files: [f] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(thumbs()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe(CAP_MSG);
  });

  it('without chat-images: send with images in the tray sends nothing', async () => {
    enableImages();
    renderMic();
    pick([png()]);
    await waitFor(() => expect(thumbs()).toHaveLength(1));
    act(() => { useStore.getState().setDeviceCapabilities('d', []); });
    fireEvent.click(sendBtn());
    expect(screen.getByRole('alert').textContent).toBe(CAP_MSG);
    expect(chatSends()).toHaveLength(0);
    expect(thumbs()).toHaveLength(1);
  });
});
