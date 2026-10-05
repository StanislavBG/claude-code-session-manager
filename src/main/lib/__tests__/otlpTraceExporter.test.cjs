/**
 * otlpTraceExporter.test.cjs — proves the zero-dependency OTLP/HTTP JSON
 * exporter encodes spans correctly and degrades quietly on failure.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/otlpTraceExporter.test.cjs
 */

import { test, expect, afterEach } from 'vitest';
const http = require('node:http');
const { createOtlpTraceExporter } = require('../otlpTraceExporter.cjs');

const servers = [];
const exporters = [];

afterEach(async () => {
  while (exporters.length) await exporters.pop().shutdown();
  while (servers.length) {
    const s = servers.pop();
    await new Promise((resolve) => s.close(resolve));
  }
});

function startServer(status = 200) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = status;
      res.end('{}');
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ received, url: `http://127.0.0.1:${server.address().port}/v1/traces` });
    });
  });
}

function make(opts) {
  const e = createOtlpTraceExporter({ flushIntervalMs: 60000, ...opts });
  exporters.push(e);
  return e;
}

test('flush POSTs an ExportTraceServiceRequest with encoded spans', async () => {
  const { received, url } = await startServer();
  const exp = make({ url, headers: { 'x-api-key': 'secret' }, serviceName: 'svc-a', scopeName: 'scope-a' });
  exp.recordSpan({
    name: 'transcript.tool_use',
    timeMs: 1700000000123,
    attributes: { s: 'str', i: 42, d: 1.5, b: true, n: null, u: undefined },
  });
  await exp.flush();

  expect(received).toHaveLength(1);
  expect(received[0].headers['content-type']).toBe('application/json');
  expect(received[0].headers['x-api-key']).toBe('secret');
  const body = JSON.parse(received[0].body);
  const rs = body.resourceSpans[0];
  expect(rs.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'svc-a' } });
  expect(rs.scopeSpans[0].scope.name).toBe('scope-a');
  const span = rs.scopeSpans[0].spans[0];
  expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  expect(span.name).toBe('transcript.tool_use');
  expect(span.kind).toBe(1);
  expect(span.startTimeUnixNano).toBe('1700000000123000000');
  expect(span.endTimeUnixNano).toBe(span.startTimeUnixNano);
  expect(span.attributes).toEqual([
    { key: 's', value: { stringValue: 'str' } },
    { key: 'i', value: { intValue: '42' } },
    { key: 'd', value: { doubleValue: 1.5 } },
    { key: 'b', value: { boolValue: true } },
  ]);
  expect(exp.stats().lastError).toBeNull();
});

test('unreachable endpoint never throws and records the failure', async () => {
  const exp = make({ url: 'http://127.0.0.1:1', serviceName: 's', scopeName: 'sc', timeoutMs: 2000 });
  expect(() => exp.recordSpan({ name: 'x', timeMs: Date.now(), attributes: {} })).not.toThrow();
  await expect(exp.flush()).resolves.toBeUndefined();
  const st = exp.stats();
  expect(st.failed).toBeGreaterThan(0);
  expect(st.lastError).toBeTruthy();
});

test('non-2xx response is recorded as a failure', async () => {
  const { url } = await startServer(500);
  const exp = make({ url, serviceName: 's', scopeName: 'sc' });
  exp.recordSpan({ name: 'x', timeMs: Date.now() });
  await expect(exp.flush()).resolves.toBeUndefined();
  expect(exp.stats().failed).toBe(1);
  expect(exp.stats().lastError).toMatch(/500/);
});

test('queue overflow drops the oldest spans and counts them', async () => {
  const { received, url } = await startServer();
  const exp = make({ url, serviceName: 's', scopeName: 'sc', maxQueue: 3 });
  for (let i = 0; i < 5; i++) exp.recordSpan({ name: `span-${i}`, timeMs: 1000 + i });
  expect(exp.stats().dropped).toBe(2);
  await exp.flush();
  const names = JSON.parse(received[0].body).resourceSpans[0].scopeSpans[0].spans.map((s) => s.name);
  expect(names).toEqual(['span-2', 'span-3', 'span-4']);
});

test('shutdown resolves under 3s against an unreachable endpoint', async () => {
  const exp = make({ url: 'http://127.0.0.1:1', serviceName: 's', scopeName: 'sc' });
  exp.recordSpan({ name: 'x', timeMs: Date.now() });
  const start = Date.now();
  await exp.shutdown();
  expect(Date.now() - start).toBeLessThan(3000);
});
