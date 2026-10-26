import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import RemoteRenderer, { sha256Hex, IFRAME_SANDBOX } from '../components/RemoteRenderer';

const enc = new TextEncoder();
const INDEX = '<html><head><link rel="stylesheet" href="./app.css"></head><body><script type="module" src="./app.js"></script></body></html>';

function frames(value: unknown, id: string, extra: Record<string, unknown> = {}) {
  return [{ type: id.includes('evt') ? 'ipc:event' : 'ipc:result', id, seq: 0, total: 1, data: JSON.stringify(value), ...extra }];
}

async function makeSocket(opts: { available?: boolean; corrupt?: string } = {}) {
  const files: Record<string, string> = { 'index.html': INDEX, 'app.css': 'body{}', 'app.js': 'console.log(1)' };
  const manifest = {
    available: opts.available !== false,
    version: '1',
    files: await Promise.all(Object.entries(files).map(async ([name, body]) => ({
      name, size: body.length, type: 'x', sha256: await sha256Hex(enc.encode(body)),
    }))),
  };
  const handlers = new Map<string, Set<(e: any) => void>>();
  const emit = (type: string, e: any) => handlers.get(type)?.forEach((h) => h(e));
  const sent: Array<{ type: string; payload: any; id: string; at: number }> = [];
  const socket = {
    on: (type: string, h: (e: any) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(h);
      return () => handlers.get(type)!.delete(h);
    },
    sendEnvelope: vi.fn(async (type: string, _d: string, payload: any, id: string) => {
      sent.push({ type, payload, id, at: Date.now() });
      if (type === 'asset:manifest') {
        setTimeout(() => frames({ ok: true, result: manifest }, id).forEach((f) => emit('ipc:result', f)), 0);
      } else if (type === 'asset:get') {
        const body = payload.name === opts.corrupt ? 'tampered!' : files[payload.name];
        setTimeout(() => frames({ ok: true, result: { data: btoa(body) } }, id).forEach((f) => emit('ipc:result', f)), 0);
      }
      return true;
    }),
  };
  return { socket: socket as any, emit, sent };
}

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as any).revokeObjectURL = vi.fn();
});

async function mounted(opts?: Parameters<typeof makeSocket>[0]) {
  const s = await makeSocket(opts);
  render(<RemoteRenderer socket={s.socket} deviceId="d1" fallback={<div data-testid="drill">drill</div>} />);
  const iframe = (await screen.findByTestId('remote-renderer')) as HTMLIFrameElement;
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage');
  const fromIframe = (data: unknown, source: any = iframe.contentWindow) =>
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
  return { ...s, iframe, post, fromIframe };
}

describe('RemoteRenderer', () => {
  it('mounts a sandboxed iframe without allow-same-origin, css inline, js from blob', async () => {
    const { iframe } = await mounted();
    expect(iframe.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('srcdoc')).toContain('<style>body{}</style>');
    expect(iframe.getAttribute('srcdoc')).toContain('src="blob:fake"');
  });

  it('refuses to mount on a hash mismatch', async () => {
    const s = await makeSocket({ corrupt: 'app.js' });
    render(<RemoteRenderer socket={s.socket} deviceId="d1" fallback={<div data-testid="drill" />} />);
    expect(await screen.findByTestId('renderer-refused')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-renderer')).toBeNull();
    expect(screen.queryByTestId('drill')).toBeNull();
  });

  it('batches calls into one ipc:invoke and resolves them', async () => {
    const { sent, fromIframe, post, emit } = await mounted();
    await fromIframe({ type: 'sm-ipc', id: 1, channel: 'a:b', args: [1] });
    await fromIframe({ type: 'sm-ipc', id: 2, channel: 'c:d', args: [] });
    await waitFor(() => expect(sent.filter((m) => m.type === 'ipc:invoke')).toHaveLength(1));
    const inv = sent.find((m) => m.type === 'ipc:invoke')!;
    expect(inv.payload.calls).toEqual([{ channel: 'a:b', args: [1] }, { channel: 'c:d', args: [] }]);
    act(() => {
      frames({ ok: true, result: 'A' }, `${inv.id}.0`).forEach((f) => emit('ipc:result', f));
      frames({ ok: false, error: 'rejected' }, `${inv.id}.1`).forEach((f) => emit('ipc:result', f));
    });
    expect(post).toHaveBeenCalledWith({ type: 'sm-ipc-result', id: 1, result: 'A' }, '*');
    expect(post).toHaveBeenCalledWith({ type: 'sm-ipc-result', id: 2, error: 'rejected' }, '*');
  });

  it('maps subscribe to ipc:subscribe and forwards joined ipc:event frames', async () => {
    const { sent, fromIframe, post, emit } = await mounted();
    await fromIframe({ type: 'sm-ipc-subscribe', channel: 'chat:event' });
    await waitFor(() => expect(sent.some((m) => m.type === 'ipc:subscribe')).toBe(true));
    expect(sent.find((m) => m.type === 'ipc:subscribe')!.payload).toEqual({ channels: ['chat:event'] });
    const json = JSON.stringify({ hello: 'world' });
    act(() => {
      emit('ipc:event', { type: 'ipc:event', id: 'e1', channel: 'chat:event', seq: 0, total: 2, data: json.slice(0, 5) });
      emit('ipc:event', { type: 'ipc:event', id: 'e2', channel: 'chat:event', seq: 1, total: 2, data: json.slice(5) });
    });
    expect(post).toHaveBeenCalledWith({ type: 'sm-ipc-event', channel: 'chat:event', args: [{ hello: 'world' }] }, '*');
  });

  it('ignores messages from any source other than the iframe', async () => {
    const { sent, fromIframe } = await mounted();
    await fromIframe({ type: 'sm-ipc', id: 9, channel: 'x:y', args: [] }, window);
    await fromIframe({ type: 'sm-ipc', id: 9, channel: 'x:y', args: [] }, null);
    await new Promise((r) => setTimeout(r, 150));
    expect(sent.filter((m) => m.type === 'ipc:invoke')).toHaveLength(0);
  });

  it('falls back to the drill-down when the desktop reports available:false', async () => {
    const s = await makeSocket({ available: false });
    render(<RemoteRenderer socket={s.socket} deviceId="d1" fallback={<div data-testid="drill">drill</div>} />);
    expect(await screen.findByTestId('drill')).toBeInTheDocument();
    expect(screen.queryByTestId('remote-renderer')).toBeNull();
  });
});
