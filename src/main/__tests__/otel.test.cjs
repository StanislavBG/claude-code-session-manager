/**
 * otel.test.cjs — proves otel.cjs (OTLP/HTTP JSON exporter) still
 * initializes, records a span, and shuts down cleanly against an
 * unreachable endpoint.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/otel.test.cjs
 */

import { test, expect, afterEach } from 'vitest';
const otel = require('../otel.cjs');

afterEach(async () => {
  await otel.shutdown();
});

test('init resolves ok against an unreachable endpoint', async () => {
  const result = await otel.init({ endpoint: 'http://127.0.0.1:1/v1/traces' });
  expect(result).toEqual({ ok: true });
});

test('recording a transcript event after init does not throw', async () => {
  await otel.init({ endpoint: 'http://127.0.0.1:1/v1/traces' });
  expect(() => {
    otel.recordTranscriptEvent({
      tabId: 'tab-1',
      tabCwd: '/tmp/project',
      kind: 'tool_use',
      data: { name: 'Read', id: 'call-1' },
      ts: Date.now(),
    });
  }).not.toThrow();
});

test('exports a transcript.tool_use span to a receiving OTLP/HTTP server', async () => {
  const http = require('node:http');
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await otel.init({ endpoint: `http://127.0.0.1:${port}/v1/traces` });
    expect(result).toEqual({ ok: true });
    otel.recordTranscriptEvent({
      tabId: 'tab-1',
      tabCwd: '/tmp/project',
      kind: 'tool_use',
      data: { name: 'Read', id: 'call-1' },
      ts: Date.now(),
    });
    await otel.shutdown();
    expect(bodies).toHaveLength(1);
    const rs = bodies[0].resourceSpans[0];
    const svc = rs.resource.attributes.find((a) => a.key === 'service.name');
    expect(svc.value.stringValue).toBe('session-manager');
    const spans = rs.scopeSpans.flatMap((s) => s.spans);
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('transcript.tool_use');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('shutdown resolves within 3s even though the endpoint is unreachable', async () => {
  await otel.init({ endpoint: 'http://127.0.0.1:1/v1/traces' });
  const start = Date.now();
  await otel.shutdown();
  expect(Date.now() - start).toBeLessThan(3000);
});
