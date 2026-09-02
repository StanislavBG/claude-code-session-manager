/**
 * schedulerMcpServerHeadlessRefusal.test.cjs — scheduler_create_prd is
 * refused at the authoring boundary when called from inside a headless
 * scheduled job (issue #11 list C1: PRD 460 called /develop from inside its
 * own run, spawned a duplicate PRD, and exited 0 having done nothing).
 * scheduler.cjs stamps SM_SCHEDULER_JOB_SLUG on every job spawn and
 * SM_SCHEDULER_JOB_MAY_QUEUE=1 only for decomposition personas.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/schedulerMcpServerHeadlessRefusal.test.cjs
 */

'use strict';

import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs');

const tmpDirs = [];
const savedEnv = {};
for (const k of ['SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MAY_QUEUE', 'HOME']) savedEnv[k] = process.env[k];

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete require.cache[require.resolve(SERVER_PATH)];
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
});

async function freshServer() {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-mcp-headless-'));
  tmpDirs.push(homeDir);
  process.env.HOME = homeDir;
  delete require.cache[require.resolve(SERVER_PATH)];
  return require(SERVER_PATH);
}

const PRD_ARGS = { title: 'x', goal: 'y', acceptanceCriteria: ['z'] };

test('scheduler_create_prd inside a headless job is refused before any admin request', async () => {
  process.env.SM_SCHEDULER_JOB_SLUG = '460-some-prd';
  delete process.env.SM_SCHEDULER_JOB_MAY_QUEUE;
  const { handleCallTool } = await freshServer();
  const result = await handleCallTool({ params: { name: 'scheduler_create_prd', arguments: PRD_ARGS } });
  expect(result.isError).toBe(true);
  const text = result.content[0].text;
  expect(text).toMatch(/refused/);
  expect(text).toMatch(/460-some-prd/);
  expect(text).toMatch(/never queues follow-on work/);
});

test('scheduler_create_prd inside a headless job with SM_SCHEDULER_JOB_MAY_QUEUE=1 is not refused by the gate', async () => {
  process.env.SM_SCHEDULER_JOB_SLUG = '461-architect-plan';
  process.env.SM_SCHEDULER_JOB_MAY_QUEUE = '1';
  const { handleCallTool } = await freshServer();
  const result = await handleCallTool({ params: { name: 'scheduler_create_prd', arguments: PRD_ARGS } });
  // No admin API is configured in this tmp HOME, so the call fails LATER at
  // the admin request — the point is that it was not the headless refusal.
  const text = result.content[0].text;
  expect(text).not.toMatch(/never queues follow-on work/);
});

test('scheduler_create_prd outside a headless job is not refused by the gate', async () => {
  delete process.env.SM_SCHEDULER_JOB_SLUG;
  const { handleCallTool } = await freshServer();
  const result = await handleCallTool({ params: { name: 'scheduler_create_prd', arguments: PRD_ARGS } });
  expect(result.content[0].text).not.toMatch(/never queues follow-on work/);
});
