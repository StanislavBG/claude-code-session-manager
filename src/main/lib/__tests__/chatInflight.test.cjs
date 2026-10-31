'use strict';

// Run: timeout 120 npx vitest run src/main/lib/__tests__/chatInflight.test.cjs

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inflight = require('../chatInflight.cjs');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-inflight-'));
  process.env.SM_CHAT_INFLIGHT_PATH = path.join(dir, 'chat-inflight.json');
});
afterEach(async () => {
  await inflight.list();
  delete process.env.SM_CHAT_INFLIGHT_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('chatInflight', () => {
  it('missing ledger lists empty', async () => {
    expect(await inflight.list()).toEqual([]);
  });

  it('begin then list then end', async () => {
    await inflight.begin('s1', { tabId: 't1', cwd: '/x', pid: 42, startedAt: 5, resume: true });
    const l = await inflight.list();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tabId: 't1', sessionId: 's1', cwd: '/x', pid: 42, startedAt: 5, resume: true });
    await inflight.end('s1');
    expect(await inflight.list()).toEqual([]);
  });

  it('never persists prompt or env', async () => {
    await inflight.begin('s1', { tabId: 't', cwd: '/x', pid: 1, prompt: 'SECRET', childEnv: { K: 'SECRET' } });
    expect(fs.readFileSync(process.env.SM_CHAT_INFLIGHT_PATH, 'utf8')).not.toContain('SECRET');
  });

  it('corrupt ledger reads empty and recovers', async () => {
    fs.writeFileSync(process.env.SM_CHAT_INFLIGHT_PATH, '{not json');
    expect(await inflight.list()).toEqual([]);
    await inflight.begin('s2', { tabId: 't', cwd: '/x', pid: 1 });
    expect((await inflight.list()).map((e) => e.sessionId)).toEqual(['s2']);
  });

  it('concurrent writes in one process all land', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => inflight.begin(`s${i}`, { tabId: `t${i}`, cwd: '/x', pid: i })));
    expect(await inflight.list()).toHaveLength(20);
    await Promise.all(Array.from({ length: 10 }, (_, i) => inflight.end(`s${i}`)));
    expect(await inflight.list()).toHaveLength(10);
  });
});
