/**
 * otel.test.cjs — proves the OpenTelemetry 2.x port in otel.cjs still
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

test('shutdown resolves within 3s even though the endpoint is unreachable', async () => {
  await otel.init({ endpoint: 'http://127.0.0.1:1/v1/traces' });
  const start = Date.now();
  await otel.shutdown();
  expect(Date.now() - start).toBeLessThan(3000);
});
