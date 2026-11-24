// @vitest-environment node
/// <reference types="node" />
// The app tsconfig limits ambient types to vite/client; this node-env spec pulls in @types/node itself.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { keyFingerprint, snippetFor } from '../feedbackSnippet';
import { getBoxes, patchBox, deleteBox, setTokenGetter } from '../api';

const vectorsPath = fileURLToPath(
  new URL('../../../feedback-widget/schema/seal-vectors.v1.json', import.meta.url),
);
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  vectors: Array<{ boxId: string; boxPublicKey: string; boxKeyFingerprint: string }>;
};

describe('keyFingerprint', () => {
  it('matches every seal vector fingerprint', async () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);
    for (const v of vectors.vectors) {
      expect(await keyFingerprint(v.boxPublicKey)).toBe(v.boxKeyFingerprint);
    }
  });
});

describe('snippetFor', () => {
  it('returns the exact one-line embed', () => {
    expect(snippetFor('box_vector_1', 'pTlNIcwgfyw8DJGDhHkyOd')).toBe(
      '<script src="https://bilko.run/projects/session-manager/widget/v1/feedback.js" data-key="fbk1_box_vector_1.pTlNIcwgfyw8DJGDhHkyOd" async></script>',
    );
  });
});

type Call = { url: string; init?: RequestInit };

function mockFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

const header = (c: Call, k: string) => (c.init?.headers as Record<string, string> | undefined)?.[k];

const box = {
  boxId: 'box_1',
  label: 'Site',
  allowedOrigins: ['https://example.com'],
  publicKey: 'pk',
  state: 'open',
  pending: 0,
  pendingBytes: 0,
  createdAt: '2026-11-24T00:00:00Z',
  lastReceivedAt: null,
  deviceId: 'dev_1',
};

describe('box routes', () => {
  beforeEach(() => setTokenGetter(() => Promise.resolve('clerk-jwt')));
  afterEach(() => vi.unstubAllGlobals());

  it('getBoxes GETs /boxes with the Clerk bearer and returns the list', async () => {
    const calls = mockFetch(200, { boxes: [box] });
    const r = await getBoxes();
    expect(r).toEqual({ ok: true, data: [box] });
    expect(calls[0].url).toBe('/api/sm-relay/boxes');
    expect(calls[0].init?.method).toBeUndefined();
    expect(header(calls[0], 'Authorization')).toBe('Bearer clerk-jwt');
  });

  it('patchBox PATCHes only the given fields', async () => {
    const calls = mockFetch(200, { ...box, state: 'paused' });
    const r = await patchBox('box 1', { state: 'paused' });
    expect(r.ok && r.data.state).toBe('paused');
    expect(calls[0].url).toBe('/api/sm-relay/boxes/box%201');
    expect(calls[0].init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ state: 'paused' });
    expect(header(calls[0], 'Content-Type')).toBe('application/json');
    expect(header(calls[0], 'Authorization')).toBe('Bearer clerk-jwt');
  });

  it('patchBox sends label and allowedOrigins', async () => {
    const calls = mockFetch(200, box);
    await patchBox('box_1', { label: 'New', allowedOrigins: ['https://a.test'] });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      label: 'New',
      allowedOrigins: ['https://a.test'],
    });
  });

  it('deleteBox DELETEs /boxes/:id without a body', async () => {
    const calls = mockFetch(200, { ok: true });
    expect(await deleteBox('box_1')).toEqual({ ok: true, data: null });
    expect(calls[0].url).toBe('/api/sm-relay/boxes/box_1');
    expect(calls[0].init?.method).toBe('DELETE');
    expect(header(calls[0], 'Content-Type')).toBeUndefined();
  });

  it('returns the relay error code on failure', async () => {
    mockFetch(404, { error: 'box_not_found' });
    expect(await deleteBox('gone')).toEqual({ ok: false, status: 404, error: 'box_not_found' });
    mockFetch(400, { error: 'invalid_state' });
    expect(await patchBox('box_1', { state: 'open' })).toEqual({
      ok: false,
      status: 400,
      error: 'invalid_state',
    });
    mockFetch(403, { error: 'not_enabled' });
    expect(await getBoxes()).toEqual({ ok: false, status: 403, error: 'not_enabled' });
  });

  it('falls back to http_<status> when the body has no error code', async () => {
    mockFetch(500, null);
    expect(await getBoxes()).toEqual({ ok: false, status: 500, error: 'http_500' });
  });
});
