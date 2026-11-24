// End-to-end: the widget transport (src/transport.ts) against the relay drop-box mock
// (src/main/lib/feedback-remote/__tests__/helpers/relayBoxesMock.cjs), opened with the desktop's
// own envelope opener (feedbackEnvelope.cjs). Proves a report sealed in a real browser arrives
// intact, and covers key_mismatch, a disallowed origin (retried, stores nothing) and a paused box.
import { expect, test, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const widgetRoot = resolve(here, '..');
const repoRoot = resolve(widgetRoot, '..', '..');
const requireFromRoot = createRequire(join(repoRoot, 'package.json'));

const { startRelayBoxesMock } = requireFromRoot(
  './src/main/lib/feedback-remote/__tests__/helpers/relayBoxesMock.cjs',
);
const { openReportEnvelope } = requireFromRoot('./src/main/lib/feedback-remote/feedbackEnvelope.cjs');
const { generateBoxKeypair, keyFingerprint } = requireFromRoot('./src/main/lib/feedback-remote/feedbackSeal.cjs');

const DEVICE_TOKEN = 'dev-token-transport-e2e';
const PNG_W = 40;
const PNG_H = 30;

test.describe.configure({ mode: 'serial' });

interface Mock {
  baseUrl: string;
  stop: () => Promise<void>;
  state: { boxes: Map<string, any>; envelopes: Map<string, any[]>; requests: { method: string; path: string }[] };
}

let mock: Mock;
let relay: Server; // https://bilko.run stand-in: strips /api/sm-relay and forwards to the mock
let relayBase: string;
let allowedPage: Server;
let allowedOrigin: string;
let otherPage: Server;
let otherOrigin: string;

function listen(server: Server): Promise<string> {
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((ok) => {
    if (!server) return ok();
    server.closeAllConnections?.();
    server.close(() => ok());
  });
}

function relayProxy(target: string): Server {
  const t = new URL(target);
  return createServer((req, res) => {
    const path = req.url ?? '/';
    if (!path.startsWith('/api/sm-relay/')) {
      res.writeHead(404).end();
      return;
    }
    const up = request(
      {
        host: t.hostname,
        port: t.port,
        method: req.method,
        path: path.slice('/api/sm-relay'.length),
        headers: { ...req.headers, host: t.host },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
}

function pageServer(js: string): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/transport.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
    } else if (path === '/page.html') {
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>transport e2e</title><script src="/transport.js"></script>');
    } else {
      res.writeHead(404).end();
    }
  });
}

async function createBox(publicKey: string, allowedOrigins: string[]): Promise<string> {
  const res = await fetch(`${mock.baseUrl}/boxes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'transport e2e', publicKey, allowedOrigins }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { boxId: string }).boxId;
}

test.beforeAll(async () => {
  mock = await startRelayBoxesMock({ deviceToken: DEVICE_TOKEN });
  relay = relayProxy(mock.baseUrl);
  relayBase = await listen(relay);
  const bundled = await build({
    stdin: {
      contents: [
        "import { sendReport } from './src/transport.ts';",
        "import { buildReport, buildMultipart } from './src/report.ts';",
        'window.__t = { sendReport, buildReport, buildMultipart };',
      ].join('\n'),
      resolveDir: widgetRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    write: false,
    target: 'es2020',
  });
  const js = bundled.outputFiles[0].text;
  allowedPage = pageServer(js);
  allowedOrigin = await listen(allowedPage);
  otherPage = pageServer(js);
  otherOrigin = await listen(otherPage);
});

test.afterAll(async () => {
  await close(allowedPage);
  await close(otherPage);
  await close(relay);
  await mock?.stop();
});

interface PageSend {
  result: { ok: boolean; kind?: string; status?: number; id?: string };
  clientReportId: string;
  report: Record<string, any>;
  screenshotB64: string;
  annotatedB64: string;
  progress: { loaded: number; total: number }[];
}

/** Builds a real report + two PNGs in the page and sends them with sendReport. */
async function sendFromPage(page: Page, origin: string, key: string): Promise<PageSend> {
  await page.goto(`${origin}/page.html`);
  return page.evaluate(
    async ({ key, relayBase, w, h }) => {
      const t = (window as any).__t;
      const png = async (color: string): Promise<Blob> => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(3, 3, 7, 5);
        return new Promise((ok) => c.toBlob((b) => ok(b!), 'image/png'));
      };
      const b64 = async (b: Blob): Promise<string> => {
        const u = new Uint8Array(await b.arrayBuffer());
        let s = '';
        for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
        return btoa(s);
      };
      const clientReportId = crypto.randomUUID();
      const report = t.buildReport({
        clientReportId,
        config: { project: 'transport-e2e', boxId: key.slice(5, 13) },
        draft: { type: 'bug', title: 'Save button does nothing', details: 'Clicked twice — nothing.' },
        marks: [{ kind: 'pin', x: 10, y: 12, color: '#a83818', note: 'here' }],
        page: {
          url: location.href,
          title: document.title,
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
        },
        capture: { capturedAt: new Date(), width: w, height: h, scale: 1 },
        buffers: { console: [], network: [] },
        switches: { console: true, network: false },
        reporter: { id: 'u-1', name: 'Tester' },
        widgetVersion: '0.0.0-e2e',
      });
      const shot = await png('#3366cc');
      const annotated = await png('#a83818');
      const multipart = await t.buildMultipart(report, shot, annotated);
      const progress: { loaded: number; total: number }[] = [];
      const result = await t.sendReport({
        key,
        multipart,
        clientReportId,
        relayBase,
        onProgress: (p: { loaded: number; total: number }) => progress.push(p),
      });
      return {
        result,
        clientReportId,
        report,
        screenshotB64: await b64(shot),
        annotatedB64: await b64(annotated),
        progress,
      };
    },
    { key, relayBase, w: PNG_W, h: PNG_H },
  );
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const envelopePosts = (boxId: string): number =>
  mock.state.requests.filter((r) => r.method === 'POST' && r.path === `/boxes/${boxId}/envelopes`).length;

test('sealed send from an allowed origin arrives intact and opens on the desktop side', async ({ page }) => {
  const pair = generateBoxKeypair();
  const boxId = await createBox(pair.publicKey, [allowedOrigin]);
  const key = `fbk1_${boxId}.${keyFingerprint(pair.publicKey)}`;

  const sent = await sendFromPage(page, allowedOrigin, key);
  expect(sent.result.ok).toBe(true);
  expect(sent.result.id).toMatch(/^FB-[0-9A-Z]{5}$/);
  expect(sent.progress.length).toBeGreaterThan(0);
  const last = sent.progress[sent.progress.length - 1];
  expect(last.loaded).toBe(last.total);

  const envs = mock.state.envelopes.get(boxId)!;
  expect(envs).toHaveLength(1);
  expect(envs[0].clientReportId).toBe(sent.clientReportId);
  expect(envs[0].hostId).toBe(sent.result.id);
  expect(envs[0].origin).toBe(allowedOrigin);

  const post = mock.state.requests.find((r) => r.method === 'POST' && r.path === `/boxes/${boxId}/envelopes`) as any;
  expect(post.headers['content-type']).toBe('application/octet-stream');
  expect(post.headers['x-sm-envelope']).toBe('1');
  expect(post.headers['x-sm-report-id']).toBe(sent.clientReportId);

  const opened = await openReportEnvelope(envs[0].body, { privateKeyJwk: pair.privateKeyJwk, boxId });
  expect(opened.ok).toBe(true);
  expect(opened.report).toEqual(sent.report);
  expect(sha(opened.screenshot)).toBe(sha(Buffer.from(sent.screenshotB64, 'base64')));
  expect(sha(opened.annotated)).toBe(sha(Buffer.from(sent.annotatedB64, 'base64')));
  expect(sha(opened.screenshot)).not.toBe(sha(opened.annotated));
});

test('a fingerprint that does not match the served key refuses to send', async ({ page }) => {
  const served = generateBoxKeypair();
  const pinned = generateBoxKeypair();
  const boxId = await createBox(served.publicKey, [allowedOrigin]);
  const key = `fbk1_${boxId}.${keyFingerprint(pinned.publicKey)}`;

  const sent = await sendFromPage(page, allowedOrigin, key);
  expect(sent.result).toEqual({ ok: false, kind: 'key_mismatch' });
  expect(envelopePosts(boxId)).toBe(0);
  expect(mock.state.requests.some((r) => r.path === `/boxes/${boxId}/key`)).toBe(true);
  expect(mock.state.envelopes.get(boxId)).toHaveLength(0);
});

test('a page origin the box does not list stays retryable and stores nothing', async ({ page }) => {
  const pair = generateBoxKeypair();
  const boxId = await createBox(pair.publicKey, [allowedOrigin]);
  const key = `fbk1_${boxId}.${keyFingerprint(pair.publicKey)}`;

  const sent = await sendFromPage(page, otherOrigin, key);
  // A CORS-refused POST is indistinguishable from offline (status 0): retried, bounded by the outbox's MAX_TRIES, never rejected.
  expect(sent.result).toEqual({ ok: false, kind: 'retryable' });
  expect(mock.state.envelopes.get(boxId)).toHaveLength(0);
});

test('a paused box is rejected with 410', async ({ page }) => {
  const pair = generateBoxKeypair();
  const boxId = await createBox(pair.publicKey, [allowedOrigin]);
  const patch = await fetch(`${mock.baseUrl}/boxes/${boxId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'paused' }),
  });
  expect(patch.status).toBe(200);
  const key = `fbk1_${boxId}.${keyFingerprint(pair.publicKey)}`;

  const sent = await sendFromPage(page, allowedOrigin, key);
  expect(sent.result).toEqual({ ok: false, kind: 'rejected', status: 410 });
  expect(envelopePosts(boxId)).toBe(1);
  expect(mock.state.envelopes.get(boxId)).toHaveLength(0);
});
