import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../components/ProjectsScreen', () => ({
  default: ({ onOpen }: { onOpen: (p: unknown) => void }) => (
    <button data-testid="projects-screen" onClick={() => onOpen({ cwd: '/p/a', title: 'Alpha', mainTabId: 'm1', counts: {} })}>
      projects-screen
    </button>
  ),
}));
vi.mock('../components/SessionsScreen', () => ({
  default: ({ cwd, onOpen }: { cwd: string; onOpen: (t: unknown) => void }) => (
    <button onClick={() => onOpen({ kind: 'main', mainTabId: 'm1', title: 'Alpha main' })}>sessions-screen {cwd}</button>
  ),
}));
vi.mock('../components/SessionScreen', () => ({
  default: ({ projectCwd }: { projectCwd: string }) => <div>session-screen {projectCwd}</div>,
}));

import Cockpit from '../components/Cockpit';
import { sha256Hex } from '../components/RemoteRenderer';
import { useStore } from '../store';
import type { RelaySocket } from '../ws';
import { PHONE_QUERY, VIEW_MODE_KEY, defaultViewMode, loadViewMode, saveViewMode } from '../viewMode';

const enc = new TextEncoder();
const FILES: Record<string, string> = {
  'index.html': '<html><head></head><body><script type="module" src="./app.js"></script></body></html>',
  'app.js': 'console.log(1)',
};

/** Relay socket stub that serves a hash-verified desktop renderer bundle over asset:manifest / asset:get. */
async function makeSocket() {
  const manifest = {
    available: true,
    version: '1',
    files: await Promise.all(Object.entries(FILES).map(async ([name, body]) => ({
      name, size: body.length, type: 'x', sha256: await sha256Hex(enc.encode(body)),
    }))),
  };
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const reply = (id: string, value: unknown) => setTimeout(() => {
    handlers.get('ipc:result')?.forEach((h) => h({ type: 'ipc:result', id, seq: 0, total: 1, data: JSON.stringify(value) }));
  }, 0);
  const sendEnvelope = vi.fn(async (type: string, _deviceId: string, payload: { name?: string } | undefined, id: string) => {
    if (type === 'asset:manifest') reply(id, { ok: true, result: manifest });
    else if (type === 'asset:get') reply(id, { ok: true, result: { data: btoa(FILES[payload?.name ?? ''] ?? '') } });
    return true;
  });
  const on = (type: string, h: (e: unknown) => void) => {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type)!.add(h);
    return () => { handlers.get(type)!.delete(h); };
  };
  return {
    socket: { on, sendEnvelope, sendCommand: vi.fn() } as unknown as RelaySocket,
    assetRequests: () => sendEnvelope.mock.calls.map((c) => c[0]).filter((t) => t.startsWith('asset:')),
    listeners: () => [...handlers.values()].reduce((n, set) => n + set.size, 0),
  };
}

/** jsdom has no matchMedia; install one whose answer the test controls. */
function stubMatchMedia(initial: boolean) {
  const state = { matches: initial };
  const listen = vi.fn();
  const matchMedia = vi.fn((media: string) => ({
    get matches() { return state.matches; },
    media,
    onchange: null,
    addEventListener: listen,
    removeEventListener: vi.fn(),
    addListener: listen,
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  return { matchMedia, listen, set: (m: boolean) => { state.matches = m; } };
}

const toggle = () => screen.getByTestId('view-mode-toggle');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  useStore.setState({ awaitingDesktopConfirm: false, pendingSas: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('viewMode helpers', () => {
  it('defaultViewMode is phone when PHONE_QUERY matches, full when it does not or matchMedia is missing', () => {
    expect(PHONE_QUERY).toBe('(max-width: 767px), (pointer: coarse) and (max-width: 1024px)');
    const mq = stubMatchMedia(true);
    expect(defaultViewMode()).toBe('phone');
    expect(mq.matchMedia).toHaveBeenCalledWith(PHONE_QUERY);
    mq.set(false);
    expect(defaultViewMode()).toBe('full');
    vi.stubGlobal('matchMedia', undefined);
    expect(defaultViewMode()).toBe('full');
  });

  it('loadViewMode: a stored phone/full wins; any other stored value falls back to the width default', () => {
    expect(VIEW_MODE_KEY).toBe('sm-remote-view-mode');
    const mq = stubMatchMedia(true);
    localStorage.setItem(VIEW_MODE_KEY, 'full');
    expect(loadViewMode()).toBe('full');
    mq.set(false);
    localStorage.setItem(VIEW_MODE_KEY, 'phone');
    expect(loadViewMode()).toBe('phone');
    mq.set(true);
    for (const bad of ['', 'tablet', 'PHONE', '"full"', 'null']) {
      localStorage.setItem(VIEW_MODE_KEY, bad);
      expect(loadViewMode(), JSON.stringify(bad)).toBe('phone');
    }
    localStorage.removeItem(VIEW_MODE_KEY);
    expect(loadViewMode()).toBe('phone');
  });

  it('a localStorage error falls back to the width default, and saving swallows it', () => {
    stubMatchMedia(false);
    localStorage.setItem(VIEW_MODE_KEY, 'phone');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(loadViewMode()).toBe('full');
    expect(() => saveViewMode('phone')).not.toThrow();
  });

  it('saveViewMode stores the mode under VIEW_MODE_KEY', () => {
    saveViewMode('phone');
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('phone');
    saveViewMode('full');
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('full');
  });
});

describe('Cockpit view mode', () => {
  it('phone query matches: the drill-down is the main UI and no desktop asset is requested', async () => {
    stubMatchMedia(true);
    const s = await makeSocket();
    render(<Cockpit socket={s.socket} deviceId="d1" />);
    expect(screen.getByTestId('projects-screen')).toBeInTheDocument();
    expect(toggle()).toHaveTextContent('Full UI');
    await settle();
    expect(s.assetRequests()).toEqual([]);
    expect(screen.queryByTestId('renderer-loading')).toBeNull();
    expect(screen.queryByTestId('remote-renderer')).toBeNull();
  });

  it('phone query does not match: the desktop renderer mounts', async () => {
    stubMatchMedia(false);
    const s = await makeSocket();
    render(<Cockpit socket={s.socket} deviceId="d1" />);
    expect(toggle()).toHaveTextContent('Phone view');
    expect(await screen.findByTestId('remote-renderer')).toBeInTheDocument();
    expect(s.assetRequests()).toContain('asset:manifest');
    expect(screen.queryByTestId('projects-screen')).toBeNull();
  });

  it('toggling phone → full mounts the renderer and stores full; a re-mount stays full on a phone', async () => {
    stubMatchMedia(true);
    const s = await makeSocket();
    const { unmount } = render(<Cockpit socket={s.socket} deviceId="d1" />);
    expect(s.assetRequests()).toEqual([]);

    fireEvent.click(toggle());
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('full');
    expect(toggle()).toHaveTextContent('Phone view');
    expect(await screen.findByTestId('remote-renderer')).toBeInTheDocument();
    expect(s.assetRequests()).toContain('asset:manifest');
    unmount();

    const again = await makeSocket();
    render(<Cockpit socket={again.socket} deviceId="d1" />);
    expect(toggle()).toHaveTextContent('Phone view');
    expect(await screen.findByTestId('remote-renderer')).toBeInTheDocument();
    expect(again.assetRequests()).toContain('asset:manifest');
  });

  it('toggling full → phone unmounts the iframe and its IpcBridge immediately', async () => {
    stubMatchMedia(false);
    const s = await makeSocket();
    render(<Cockpit socket={s.socket} deviceId="d1" />);
    await screen.findByTestId('remote-renderer');
    expect(s.listeners()).toBeGreaterThan(0);

    fireEvent.click(toggle());
    expect(screen.queryByTestId('remote-renderer')).toBeNull();
    expect(screen.getByTestId('projects-screen')).toBeInTheDocument();
    expect(s.listeners()).toBe(0);
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('phone');
    expect(toggle()).toHaveTextContent('Full UI');
  });

  it.each([
    [true, 'phone'],
    [false, 'full'],
  ] as const)('an invalid stored value falls back to the width default (phone query %s → %s)', async (matches, mode) => {
    localStorage.setItem(VIEW_MODE_KEY, 'tablet');
    stubMatchMedia(matches);
    const s = await makeSocket();
    render(<Cockpit socket={s.socket} deviceId="d1" />);
    expect(toggle()).toHaveTextContent(mode === 'phone' ? 'Full UI' : 'Phone view');
    await settle();
    expect(s.assetRequests().includes('asset:manifest')).toBe(mode === 'full');
  });

  it('matchMedia undefined → full', async () => {
    vi.stubGlobal('matchMedia', undefined);
    const s = await makeSocket();
    render(<Cockpit socket={s.socket} deviceId="d1" />);
    expect(toggle()).toHaveTextContent('Phone view');
    expect(await screen.findByTestId('remote-renderer')).toBeInTheDocument();
  });

  it('does not re-evaluate the mode on resize or rotation', async () => {
    const mq = stubMatchMedia(true);
    const s = await makeSocket();
    const { rerender } = render(<Cockpit socket={s.socket} deviceId="d1" />);
    mq.set(false);
    act(() => {
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
    });
    rerender(<Cockpit socket={s.socket} deviceId="d1" />);
    await settle();
    expect(toggle()).toHaveTextContent('Full UI');
    expect(screen.getByTestId('projects-screen')).toBeInTheDocument();
    expect(s.assetRequests()).toEqual([]);
    expect(mq.listen).not.toHaveBeenCalled();
  });

  it('phone mode keeps the projects → sessions → session route and browser back', async () => {
    stubMatchMedia(true);
    const s = await makeSocket();
    render(<Cockpit socket={s.socket} deviceId="d1" />);
    fireEvent.click(screen.getByTestId('projects-screen'));
    expect(useStore.getState().route.view).toBe('sessions');
    fireEvent.click(screen.getByText(/sessions-screen/));
    expect(screen.getByText('session-screen /p/a')).toBeInTheDocument();

    window.history.back();
    await waitFor(() => expect(useStore.getState().route.view).toBe('sessions'));
    window.history.back();
    await waitFor(() => expect(useStore.getState().route.view).toBe('projects'));
    expect(screen.getByTestId('projects-screen')).toBeInTheDocument();
    expect(s.assetRequests()).toEqual([]);
  });

  it('the toggle is a tracked touch-size button', () => {
    stubMatchMedia(true);
    render(<Cockpit socket={null} deviceId="d1" />);
    expect(toggle().tagName).toBe('BUTTON');
    expect(toggle()).toHaveAttribute('data-track', 'cockpit-view-mode');
    expect(toggle().className).toContain('min-h-touch');
  });
});
