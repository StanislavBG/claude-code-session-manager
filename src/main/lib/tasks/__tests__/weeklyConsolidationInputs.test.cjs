/**
 * weeklyConsolidationInputs.test.cjs — own-project transcripts + Lessons, half-open windows.
 * Run: timeout 120 npx vitest run src/main/lib/tasks/__tests__/weeklyConsolidationInputs.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const w = require('../weeklyConsolidationInputs.cjs');

const ROOT = '/home/u/proj';
const WT = '/home/u/.local/state/session-manager/session-manager-job-worktrees/h/1-x';
const PD = '/p';

// files: { '<folder>/<name>': { mtimeMs, cwd } }
function tdeps(files) {
  const folders = {};
  for (const k of Object.keys(files)) { const [f, n] = k.split('/'); (folders[f] ||= []).push(n); }
  return {
    projectsDir: PD,
    readdir: (d) => (d === PD ? Object.keys(folders) : folders[d.slice(PD.length + 1)] || []),
    stat: (p) => { const f = files[p.slice(PD.length + 1)]; return f ? { mtimeMs: f.mtimeMs } : null; },
    readFirstCwd: (p) => files[p.slice(PD.length + 1)]?.cwd ?? null,
    mainRootOf: (c) => (c === WT ? ROOT : null),
  };
}
const own = '-home-u-proj';
const sib = '-home-u-proj-two';
const wtf = '-home-u--local-state-session-manager-session-manager-job-worktrees-h-1-x';

test('own vs sibling prefix project, worktree mapped, subagents excluded', () => {
  const files = {
    [`${own}/a.jsonl`]: { mtimeMs: 100, cwd: ROOT },
    [`${sib}/b.jsonl`]: { mtimeMs: 100, cwd: '/home/u/proj-two' },
    [`${wtf}/c.jsonl`]: { mtimeMs: 100, cwd: WT },
    [`${own}/subagents`]: { mtimeMs: 100, cwd: ROOT },
    ['-other/d.jsonl']: { mtimeMs: 100, cwd: '/x' },
  };
  const r = w.listProjectTranscripts({ cwd: ROOT, sinceMs: 0, untilMs: 1000, deps: tdeps(files) });
  expect(r.transcripts.map((t) => t.sessionId).sort()).toEqual(['a', 'c']);
  expect(r.range).toEqual({ since: 0, until: 1000 });
  expect(r.transcripts[0]).toHaveProperty('cwd');
});

test('window is half-open; consecutive windows never overlap', () => {
  const files = { [`${own}/a.jsonl`]: { mtimeMs: 100, cwd: ROOT }, [`${own}/b.jsonl`]: { mtimeMs: 200, cwd: ROOT } };
  const d = tdeps(files);
  const r1 = w.listProjectTranscripts({ cwd: ROOT, sinceMs: 0, untilMs: 100, deps: d });
  const r2 = w.listProjectTranscripts({ cwd: ROOT, sinceMs: 100, untilMs: 200, deps: d });
  const r3 = w.listProjectTranscripts({ cwd: ROOT, sinceMs: 200, untilMs: 300, deps: d });
  expect(r1.transcripts).toHaveLength(0);
  expect(r2.transcripts.map((t) => t.sessionId)).toEqual(['a']);
  expect(r3.transcripts.map((t) => t.sessionId)).toEqual(['b']);
});

test('cap at 200 newest with truncated count', () => {
  const files = {};
  for (let i = 0; i < 205; i++) files[`${own}/s${i}.jsonl`] = { mtimeMs: 10 + i, cwd: ROOT };
  const r = w.listProjectTranscripts({ cwd: ROOT, sinceMs: 0, untilMs: 1e6, deps: tdeps(files) });
  expect(r.transcripts).toHaveLength(200);
  expect(r.truncated).toBe(5);
  expect(r.transcripts[0].sessionId).toBe('s204');
});

test('empty inputs', () => {
  expect(w.listProjectTranscripts({ cwd: ROOT, sinceMs: 0, untilMs: 1, deps: tdeps({}) }).transcripts).toEqual([]);
  expect(w.listProjectTranscripts({ sinceMs: 0, untilMs: 1, deps: tdeps({}) }).transcripts).toEqual([]);
  expect(w.collectLessons({ cwd: ROOT, sinceMs: 0, untilMs: 1, deps: { readJobs: () => [] } }).lessons).toEqual([]);
  expect(w.parseLessonsBlock('')).toEqual([]);
  expect(w.parseLessonsBlock('no block here')).toEqual([]);
});

const T = (iso) => Date.parse(iso);
function ldeps(jobs, texts, structured = {}) {
  return {
    readJobs: () => jobs,
    mainRootOf: (c) => (c === WT ? ROOT : null),
    readResultText: (p) => texts[p] ?? null,
    readStructured: (p) => structured[p] ?? null,
  };
}

test('lessons: dev-lead trailing block + validator field, own project only, 3 lines, 200 chars', () => {
  const long = 'x'.repeat(300);
  const jobs = [
    { id: 'j1', slug: 'p1', cwd: ROOT, finishedAt: '2026-11-20T00:00:00Z', logPath: 'l1' },
    { id: 'j2', slug: 'p2', cwd: WT, finishedAt: '2026-11-21T00:00:00Z', logPath: 'l2', agentType: 'validator' },
    { id: 'j3', slug: 'p3', cwd: '/home/u/proj-two', finishedAt: '2026-11-21T00:00:00Z', logPath: 'l3' },
    { id: 'j4', slug: 'p4', cwd: ROOT, finishedAt: null, logPath: 'l4' },
  ];
  const texts = {
    l1: `done\n\nLessons:\n- a\n- ${long}\n- c\n- d`,
    l3: 'Lessons:\n- other',
    l4: 'Lessons:\n- unfinished',
  };
  const so = { l2: { verdicts: [{ prd: 'p9', lessons: ['v1'] }], lessons: 'top1\ntop2' } };
  const r = w.collectLessons({ cwd: ROOT, sinceMs: T('2026-11-19T00:00:00Z'), untilMs: T('2026-11-26T00:00:00Z'), deps: ldeps(jobs, texts, so) });
  expect(r.lessons).toHaveLength(3);
  expect(r.lessons[0]).toMatchObject({ slug: 'p1', jobId: 'j1', source: 'dev-lead' });
  expect(r.lessons[0].lines).toHaveLength(3);
  expect(r.lessons[0].lines[1]).toHaveLength(200);
  expect(r.lessons[1]).toMatchObject({ slug: 'p2', source: 'validator', lines: ['top1', 'top2'] });
  expect(r.lessons[2]).toMatchObject({ slug: 'p9', lines: ['v1'] });
});

test('second run over the same week reads zero (consecutive windows)', () => {
  const jobs = [{ id: 'j1', slug: 'p1', cwd: ROOT, finishedAt: '2026-11-23T00:00:00Z', logPath: 'l1' }];
  const d = ldeps(jobs, { l1: 'Lessons:\n- a' });
  const a = T('2026-11-16T00:00:00Z'); const b = T('2026-11-23T00:00:00Z'); const c = T('2026-11-30T00:00:00Z');
  expect(w.collectLessons({ cwd: ROOT, sinceMs: a, untilMs: b, deps: d }).lessons).toHaveLength(0);
  expect(w.collectLessons({ cwd: ROOT, sinceMs: b, untilMs: c, deps: d }).lessons).toHaveLength(1);
  expect(w.collectLessons({ cwd: ROOT, sinceMs: c, untilMs: c + 7 * 86400000, deps: d }).lessons).toHaveLength(0);
});
