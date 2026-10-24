'use strict';
import { describe, it, expect, vi } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const config = require('../../../config.cjs');
const { resolveEpicPrdWriteDir } = require('../../prd/prdLocations.cjs');
const { createPrd } = require('../../prd/prdCreate.cjs');
const counters = require('../telemetryCounters.cjs');
const { trackEpicCreate, trackPrdCreate } = counters;

function rec() {
  const calls = [];
  return { calls, deps: { telemetryClient: { track: (n, p) => calls.push([n, p]) } } };
}

describe('telemetryDelegationSignals', () => {
  it('maps shipped tag + persona through', () => {
    const { calls, deps } = rec();
    trackEpicCreate({ tag: 'bug', agentType: 'architect' }, deps);
    expect(calls).toEqual([['epic.create', { tag: 'bug', agentType: 'architect' }]]);
  });
  it('maps user persona to custom and unknown tag to other', () => {
    const { calls, deps } = rec();
    trackEpicCreate({ tag: 'my-secret-tag', agentType: 'jane-private-persona' }, deps);
    expect(calls[0][1]).toEqual({ tag: 'other', agentType: 'custom' });
  });
  it('sends null when absent', () => {
    const { calls, deps } = rec();
    trackEpicCreate({}, deps);
    expect(calls[0][1]).toEqual({ tag: null, agentType: null });
  });
  it('prd.create maps agentType', () => {
    const { calls, deps } = rec();
    trackPrdCreate({ agentType: 'dev-lead' }, deps);
    trackPrdCreate({ agentType: 'mine' }, deps);
    expect(calls).toEqual([['prd.create', { agentType: 'dev-lead' }], ['prd.create', { agentType: 'custom' }]]);
  });
});

describe('createPrd -> prd.create', () => {
  const mk = async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-prd-tel-'));
    config.addAllowedRoot(cwd);
    const remote = {
      allocateParallelGroup: async () => 7,
      async readPrd() { return { ok: false }; },
      async writePrd() { return { ok: true }; },
      async listPrds() { return { prds: [], total: 0, limit: 0, offset: 0, hasMore: false }; },
    };
    const body = { title: 'Tel PRD', slug: 'tel-prd', cwd, sourcePromptId: 'epic-t', estimateMinutes: 10, goal: 'g', acceptanceCriteria: ['a'], implementationNotes: 'n' };
    return { cwd, remote, body };
  };

  it('fires once on a new write, never on alreadyExisted', async () => {
    const spy = vi.spyOn(counters, 'trackPrdCreate').mockImplementation(() => {});
    const { cwd, remote, body } = await mk();
    const r1 = await createPrd(body, remote);
    expect(r1.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    const dir = resolveEpicPrdWriteDir(cwd, 'epic-t');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '5-tel-prd.md'), '---\ntitle: Tel PRD\n---\n');
    const r2 = await createPrd(body, remote);
    expect(r2.alreadyExisted).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not fire when the write fails', async () => {
    const spy = vi.spyOn(counters, 'trackPrdCreate').mockImplementation(() => {});
    const { remote, body } = await mk();
    const r = await createPrd(body, { ...remote, writePrd: async () => ({ ok: false, error: 'x' }) });
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
