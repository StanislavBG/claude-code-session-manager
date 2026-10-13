'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/remoteDrilldown.test.cjs

import { describe, it, expect } from 'vitest';
const { listRemoteProjects, listRemoteProjectSessions } = require('../remoteDrilldown.cjs');

const tabs = [
  { id: 't1', cwd: '/p/zeta', label: 'Zeta' },
  { id: 't2', cwd: '/p/alpha' },
  { id: 't3', cwd: '/p/alpha' },
  { sessionId: 't4', cwd: '' },
];

const epics = {
  a: { id: 'a', status: 'active', goalText: 'Do a thing\nmore', claudeSessionId: 'c-a', updatedAt: '2026-01-02T00:00:00Z', tag: 'build', agentType: 'dev' },
  b: { id: 'b', status: 'active', updatedAt: 5000, worktree: { dir: '/wt/b' } },
  c: { id: 'c', status: 'proposed', createdAt: 1000, cwd: '/p/alpha' },
  d: { id: 'd', status: 'completed', completedAt: 3000 },
  e: { id: 'e', status: 'completed', completedAt: 4000 },
  f: { id: 'f', status: 'weird' },
  g: { id: 'g', status: 'proposed', updatedAt: 'garbage' },
};
const readIndex = (cwd) => (cwd === '/p/alpha' ? { sessions: epics } : { sessions: {} });

describe('listRemoteProjects', () => {
  it('counts per status, dedupes cwds, sorts by title', () => {
    const out = listRemoteProjects(tabs, readIndex);
    expect(out.map((p) => p.title)).toEqual(['Zeta', 'alpha'].sort((x, y) => x.localeCompare(y)));
    const alpha = out.find((p) => p.cwd === '/p/alpha');
    expect(alpha.counts).toEqual({ proposed: 2, active: 2, completed: 2 });
    expect(alpha.mainTabId).toBe('t2');
    expect(out).toHaveLength(2);
  });
  it('readIndex throwing gives zero counts', () => {
    const out = listRemoteProjects(tabs, () => { throw new Error('x'); });
    expect(out[0].counts).toEqual({ proposed: 0, active: 0, completed: 0 });
  });
});

describe('listRemoteProjectSessions', () => {
  it('unknown cwd => null', () => {
    expect(listRemoteProjectSessions(tabs, readIndex, '/nope')).toBeNull();
  });
  it('orders active, proposed, completed; newest first; drops unknown status', () => {
    const { project, sessions } = listRemoteProjectSessions(tabs, readIndex, '/p/alpha');
    expect(project).toEqual({ cwd: '/p/alpha', title: 'alpha', mainTabId: 't2' });
    expect(sessions.map((s) => s.epicId)).toEqual(['a', 'b', 'c', 'g', 'e', 'd']);
    expect(sessions.find((s) => s.epicId === 'b').spawnCwd).toBe('/wt/b');
    expect(sessions.find((s) => s.epicId === 'c').spawnCwd).toBe('/p/alpha');
    expect(sessions.find((s) => s.epicId === 'g').updatedAt).toBeNull();
    expect(sessions.find((s) => s.epicId === 'a').updatedAt).toBe(Date.parse('2026-01-02T00:00:00Z'));
  });
  it('caps completed entries', () => {
    const { sessions } = listRemoteProjectSessions(tabs, readIndex, '/p/alpha', { completedLimit: 1 });
    expect(sessions.filter((s) => s.status === 'completed').map((s) => s.epicId)).toEqual(['e']);
  });
  it('title falls back to epicId; claudeSessionId null when absent', () => {
    const { sessions } = listRemoteProjectSessions(tabs, readIndex, '/p/alpha');
    const a = sessions.find((s) => s.epicId === 'a');
    const b = sessions.find((s) => s.epicId === 'b');
    expect(a.title).toBe('Do a thing');
    expect(b.title).toBe('b');
    expect(b.claudeSessionId).toBeNull();
  });
  it('readIndex throwing => empty sessions', () => {
    const out = listRemoteProjectSessions(tabs, () => { throw new Error('x'); }, '/p/alpha');
    expect(out.sessions).toEqual([]);
  });
});
