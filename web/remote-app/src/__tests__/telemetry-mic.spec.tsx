import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { trackFlow, trackScreen, track } = vi.hoisted(() => ({
  trackFlow: vi.fn(),
  trackScreen: vi.fn(),
  track: vi.fn(),
}));
vi.mock('../telemetry', () => ({ trackFlow, trackScreen, track, APP: 'session-manager' }));

const { sendChat } = vi.hoisted(() => ({ sendChat: vi.fn() }));
vi.mock('../remoteApi', () => ({ sendChat }));

import MicPane from '../components/MicPane';
import { useStore } from '../store';

const socket: any = { sendCommand: vi.fn() };
const renderMic = () => render(<MicPane socket={socket} deviceId="dev1" target="epic-1" />);

beforeEach(() => {
  trackFlow.mockClear();
  trackScreen.mockClear();
  sendChat.mockReset();
  delete (window as any).SpeechRecognition;
  delete (window as any).webkitSpeechRecognition;
  useStore.getState().reset();
});

describe('MicPane telemetry', () => {
  it('tags chips with mic-chip and redact', () => {
    renderMic();
    const chip = screen.getByText('continue');
    expect(chip.getAttribute('data-track')).toBe('mic-chip');
    expect(chip.hasAttribute('data-track-redact')).toBe(true);
  });

  it('tags the text send button', () => {
    renderMic();
    fireEvent.change(screen.getByPlaceholderText('Type a command…'), { target: { value: 'hi' } });
    expect(screen.getByLabelText('Send command').getAttribute('data-track')).toBe('mic-send');
  });

  it('tags the start-mic button and sheet buttons, emitting mic-sheet screen', () => {
    (window as any).SpeechRecognition = class {
      lang = ''; interimResults = false; continuous = false;
      onresult = null; onend = null; onerror = null;
      start() {} stop() {}
    };
    renderMic();
    const start = screen.getByLabelText('Start voice input');
    expect(start.getAttribute('data-track')).toBe('mic-start');
    expect(trackScreen).not.toHaveBeenCalled();
    fireEvent.click(start);
    expect(trackScreen).toHaveBeenCalledWith('mic-sheet');
    expect(trackScreen).toHaveBeenCalledTimes(1);
    const tracked = Array.from(document.querySelectorAll('[data-track]')).map((e) => e.getAttribute('data-track'));
    expect(tracked).toEqual(expect.arrayContaining(['mic-sheet-close', 'mic-sheet-cancel', 'mic-sheet-send']));
  });

  it('emits chat-send start/success for a chip, without message text', async () => {
    sendChat.mockResolvedValue({});
    renderMic();
    fireEvent.click(screen.getByText('continue'));
    await waitFor(() => expect(trackFlow).toHaveBeenCalledWith('chat-send', 'success', { source: 'chip' }));
    expect(trackFlow).toHaveBeenCalledWith('chat-send', 'start', { source: 'chip' });
    expect(JSON.stringify(trackFlow.mock.calls)).not.toContain('continue');
  });

  it('emits chat-send fail with send-error', async () => {
    sendChat.mockRejectedValue(new Error('boom'));
    renderMic();
    fireEvent.change(screen.getByPlaceholderText('Type a command…'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByLabelText('Send command'));
    await waitFor(() =>
      expect(trackFlow).toHaveBeenCalledWith('chat-send', 'fail', { source: 'text', reason: 'send-error' }));
    expect(JSON.stringify(trackFlow.mock.calls)).not.toContain('secret');
  });
});
