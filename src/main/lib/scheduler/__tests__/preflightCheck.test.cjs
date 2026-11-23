'use strict';
import { test, expect, describe } from 'vitest';
const os = require('node:os');
const {
  normalizePreflight, preflightDelayMs, runPreflight, armPreflightHold,
} = require('../preflightCheck.cjs');

const MIN = 60 * 1000;

describe('normalizePreflight', () => {
  test('returns the trimmed command for a valid one-line command', () => {
    expect(normalizePreflight('  node -e "process.exit(0)"  ')).toBe('node -e "process.exit(0)"');
    expect(normalizePreflight('timeout 30 curl -sf https://example.com')).toBe('timeout 30 curl -sf https://example.com');
  });
  test('returns null for empty or absent', () => {
    expect(normalizePreflight(undefined)).toBeNull();
    expect(normalizePreflight(null)).toBeNull();
    expect(normalizePreflight('')).toBeNull();
    expect(normalizePreflight('   ')).toBeNull();
  });
  test('throws for a multi-line value', () => {
    expect(() => normalizePreflight('echo a\necho b')).toThrow(/one line/);
  });
  test('throws for an over-long value', () => {
    expect(() => normalizePreflight(`echo ${'a'.repeat(600)}`)).toThrow(/500/);
  });
  test('throws for a gate-invalid value', () => {
    expect(() => normalizePreflight('echo a | grep a')).toThrow(/preflight/);
    expect(() => normalizePreflight('echo $(whoami)')).toThrow(/preflight/);
    expect(() => normalizePreflight('# comment')).toThrow(/preflight/);
    expect(() => normalizePreflight('none')).toThrow(/preflight/);
    expect(() => normalizePreflight(42)).toThrow(/preflight/);
  });
});

describe('preflightDelayMs', () => {
  test('ladder 10, 20, 40, 60 then 60 forever', () => {
    expect(preflightDelayMs(1)).toBe(10 * MIN);
    expect(preflightDelayMs(2)).toBe(20 * MIN);
    expect(preflightDelayMs(3)).toBe(40 * MIN);
    expect(preflightDelayMs(4)).toBe(60 * MIN);
    expect(preflightDelayMs(5)).toBe(60 * MIN);
    expect(preflightDelayMs(100)).toBe(60 * MIN);
  });
  test('attempt < 1 is treated as 1', () => {
    expect(preflightDelayMs(0)).toBe(10 * MIN);
    expect(preflightDelayMs(-3)).toBe(10 * MIN);
    expect(preflightDelayMs(undefined)).toBe(10 * MIN);
  });
});

describe('armPreflightHold', () => {
  const now = Date.parse('2026-11-22T10:00:00.000Z');
  const result = { ok: false, exitCode: 1, timedOut: false, outputTail: 'not yet' };
  test('first hold starts at attempt 1', () => {
    const h = armPreflightHold(null, result, now, 'Accept the store agreement');
    expect(h).toEqual({
      since: new Date(now).toISOString(),
      attempts: 1,
      nextAt: new Date(now + 10 * MIN).toISOString(),
      lastExit: 1,
      lastOutputTail: 'not yet',
      failText: 'Accept the store agreement',
    });
  });
  test('later holds keep since and count up', () => {
    const first = armPreflightHold(undefined, result, now, 'x');
    const later = now + 30 * MIN;
    const second = armPreflightHold(first, { ...result, exitCode: 2, outputTail: 'still no' }, later, 'x');
    expect(second.since).toBe(first.since);
    expect(second.attempts).toBe(2);
    expect(second.nextAt).toBe(new Date(later + 20 * MIN).toISOString());
    expect(second.lastExit).toBe(2);
    expect(second.lastOutputTail).toBe('still no');
    const fifth = armPreflightHold({ ...second, attempts: 4 }, result, later, 'x');
    expect(fifth.attempts).toBe(5);
    expect(fifth.nextAt).toBe(new Date(later + 60 * MIN).toISOString());
  });
});

describe('runPreflight', () => {
  const cwd = os.tmpdir();
  test('exit 0 is ok', async () => {
    const r = await runPreflight({ command: 'node -e "console.log(\'ready\')"', cwd });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.outputTail).toContain('ready');
  });
  test('exit 1 is not ok and keeps the last 500 chars of output', async () => {
    const r = await runPreflight({
      command: 'node -e "console.error(\'x\'.repeat(800)+\'END\');process.exit(1)"',
      cwd,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.timedOut).toBe(false);
    expect(r.outputTail.length).toBeLessThanOrEqual(500);
    expect(r.outputTail).toContain('END');
  });
  test('a timeout kills the child', async () => {
    const t0 = Date.now();
    const r = await runPreflight({ command: 'node -e "setTimeout(()=>{},30000)"', cwd, timeoutMs: 500 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10000);
  });
});
