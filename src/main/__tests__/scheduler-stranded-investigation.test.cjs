/**
 * scheduler-stranded-investigation.test.cjs — findStrandedInvestigations: a
 * job left 'investigating' with nothing to restore it once the process that
 * spawned its probe is gone.
 *
 * spawnInvestigation's own restore (onExit / synchronous-throw catch) runs
 * ONLY inside the live process that spawned the probe. An app restart (or
 * crash) mid-probe leaves the row frozen at 'investigating' forever — the
 * comment at spawnInvestigation's onExit already asserts "'investigating'
 * must never be the job's resting state", but nothing enforced that across a
 * restart. Live repro (burrow, 2026-09-01): 834-session-summary-... sat
 * 'investigating' for 1653 minutes even though finishedAt+exitCode were
 * already recorded 27h earlier.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/scheduler-stranded-investigation.test.cjs
 */

'use strict';

// vitest, NOT node:test — this repo's suite is vitest-only (CLAUDE.md).
import { test } from 'vitest';
const assert = require('node:assert/strict');
const { findStrandedInvestigations, INVESTIGATION_MAX_MS } = require('../scheduler.cjs');

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const agoMin = (m) => new Date(NOW - m * 60_000).toISOString();
const neverAlive = () => false;
const alwaysAlive = () => true;

test('stranded past the window is selected, with the pre-probe status as restoreStatus', () => {
  const jobs = [
    {
      slug: 'a',
      cwd: '/p1',
      status: 'investigating',
      statusHistory: [
        { from: 'failed', to: 'investigating', at: agoMin(120), reason: 'spawning investigation probe' },
      ],
    },
  ];
  const out = findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].slug, 'a');
  assert.strictEqual(out[0].restoreStatus, 'failed');
  assert.ok(out[0].ageMs >= 119 * 60_000);
});

test('within the window is left alone — a live probe must not be yanked mid-flight', () => {
  const jobs = [
    {
      slug: 'b',
      cwd: '/p1',
      status: 'investigating',
      statusHistory: [{ from: 'needs_review', to: 'investigating', at: agoMin(10) }],
    },
  ];
  assert.deepStrictEqual(findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive), []);
});

test('a live probe process (pid alive) is never restored, even past the window', () => {
  const jobs = [
    {
      slug: 'c',
      cwd: '/p1',
      status: 'investigating',
      runtime: { pid: 4242 },
      statusHistory: [{ from: 'failed', to: 'investigating', at: agoMin(120) }],
    },
  ];
  assert.deepStrictEqual(findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, alwaysAlive), []);
});

test('a row with no runtime.pid past the window is still selected (dead-process default)', () => {
  const jobs = [
    {
      slug: 'd',
      cwd: '/p1',
      status: 'investigating',
      statusHistory: [{ from: 'failed', to: 'investigating', at: agoMin(120) }],
    },
  ];
  const out = findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, alwaysAlive);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].slug, 'd');
});

test('missing statusHistory transition is warn-logged and not restored — cannot prove age', () => {
  const jobs = [{ slug: 'e', cwd: '/p1', status: 'investigating', statusHistory: [] }];
  const warnSpy = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnSpy.push(args.join(' '));
  try {
    const out = findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive);
    assert.deepStrictEqual(out, []);
    assert.ok(warnSpy.some((line) => line.includes('e') && line.includes('no statusHistory entry')), `expected a warn mentioning slug 'e', got: ${JSON.stringify(warnSpy)}`);
  } finally {
    console.warn = origWarn;
  }
});

test('unparseable transition timestamp is warn-logged and not restored', () => {
  const jobs = [
    {
      slug: 'f',
      cwd: '/p1',
      status: 'investigating',
      statusHistory: [{ from: 'failed', to: 'investigating', at: 'not-a-date' }],
    },
  ];
  const warnSpy = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnSpy.push(args.join(' '));
  try {
    const out = findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive);
    assert.deepStrictEqual(out, []);
    assert.ok(warnSpy.some((line) => line.includes('f') && line.includes('unparseable')), `expected a warn mentioning slug 'f', got: ${JSON.stringify(warnSpy)}`);
  } finally {
    console.warn = origWarn;
  }
});

test('the burrow-834 shape: finishedAt + non-null exitCode already recorded is restored using that recorded outcome, not re-run', () => {
  const jobs = [
    {
      slug: '834-session-summary-reports-planner-intent-as-outcome',
      cwd: '/home/bilko/Projects/burrow',
      status: 'investigating',
      finishedAt: '2026-08-31T15:13:15.181Z',
      exitCode: 0,
      error: 'is_error=true in final 20% of transcript (event 91/101)',
      estimateMinutes: 60,
      statusHistory: [
        { from: 'needs_review', to: 'investigating', at: '2026-08-31T15:20:00.000Z', reason: 'spawning investigation probe' },
      ],
    },
  ];
  const out = findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].restoreStatus, 'needs_review');
  assert.ok(out[0].ageMs / 60_000 > 1200, `expected well past the 60m threshold, got ${out[0].ageMs / 60_000}m`);
});

test('only the most recent investigating transition is used when a job was investigated more than once', () => {
  const jobs = [
    {
      slug: 'g',
      cwd: '/p1',
      status: 'investigating',
      statusHistory: [
        { from: 'failed', to: 'investigating', at: agoMin(500) },
        { from: 'investigating', to: 'failed', at: agoMin(400) },
        { from: 'failed', to: 'investigating', at: agoMin(10) }, // recent retry — still within the window
      ],
    },
  ];
  assert.deepStrictEqual(findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive), []);
});

test('non-investigating rows are never considered', () => {
  const base = { cwd: '/p1', statusHistory: [{ from: 'x', to: 'investigating', at: agoMin(500) }] };
  const jobs = [
    { ...base, slug: 'h', status: 'failed' },
    { ...base, slug: 'i', status: 'running' },
    { ...base, slug: 'j', status: 'needs_review' },
  ];
  assert.deepStrictEqual(findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive), []);
});

test('a corrupted/illegal statusHistory `from` value falls back to failed rather than being handed to transitionJob unvalidated', () => {
  const jobs = [
    {
      slug: 'k',
      cwd: '/p1',
      status: 'investigating',
      statusHistory: [{ from: 'quarantined', to: 'investigating', at: agoMin(120) }],
    },
  ];
  const out = findStrandedInvestigations(jobs, NOW, INVESTIGATION_MAX_MS, neverAlive);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].restoreStatus, 'failed');
});

test('the shipped default is the documented one (60 minutes)', () => {
  assert.strictEqual(INVESTIGATION_MAX_MS, 60 * 60_000);
});
