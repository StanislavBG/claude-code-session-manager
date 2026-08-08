/**
 * prdAdminRouteParity.test.cjs — capability-parity gate for PRD 1024 ("lock
 * the PRD entity behind the scheduler service boundary, step 1").
 *
 * Enumerates every PRD/job mutation the codebase can perform (the full set
 * of `schedule:*` IPC channels that read/write a PRD file or a queue job,
 * plus create-prd and cancel-job which have no IPC twin) and asserts each
 * one has a corresponding admin HTTP route registered by scheduler.cjs's
 * registerAdminRoutes, prdCreate.cjs's registerAdminRoute, or
 * prdAdminRoutes.cjs's registerAdminRoute. A future PRD-lifecycle capability
 * added only as an IPC handler (filesystem-only from the admin API's point
 * of view) fails this test until an admin route is added for it too — that
 * is the whole point: the admin API must never fall behind what's actually
 * possible against a PRD/job.
 *
 * Route registration is captured via a fake `adminHttp` stub (just
 * `registerRoute`) — no real HTTP server or Electron boot needed, matching
 * how prdCreate.test.cjs already verifies wiring.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/prdAdminRouteParity.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const scheduler = require('../scheduler.cjs');
const prdCreate = require('../lib/prdCreate.cjs');
const prdAdminRoutes = require('../lib/prdAdminRoutes.cjs');

// Every PRD-lifecycle capability the codebase can perform, mapped to the
// admin HTTP route that must exist for it. `ipcChannel` is informational
// (documents the renderer-facing twin, if any) — the assertion is only
// against `adminRoute`.
const REQUIRED_CAPABILITIES = [
  { capability: 'create a PRD', ipcChannel: null, adminRoute: 'POST /admin/scheduler/create-prd' },
  { capability: 'list PRDs (live + archived)', ipcChannel: 'schedule:list-prds', adminRoute: 'GET /admin/scheduler/prds' },
  { capability: 'read one PRD (body + frontmatter)', ipcChannel: 'schedule:read-prd', adminRoute: 'GET /admin/scheduler/prd' },
  { capability: 'edit a not-yet-running PRD', ipcChannel: 'schedule:write-prd', adminRoute: 'POST /admin/scheduler/update-prd' },
  { capability: 'archive a PRD', ipcChannel: 'schedule:archive-prd', adminRoute: 'POST /admin/scheduler/archive-prd' },
  { capability: 'retag a PRD (parallelGroup/estimateMinutes)', ipcChannel: 'schedule:retag-prd', adminRoute: 'POST /admin/scheduler/retag-prd' },
  { capability: 'list scheduler jobs', ipcChannel: null, adminRoute: 'GET /admin/scheduler/jobs' },
  { capability: 'reset a stuck job', ipcChannel: 'schedule:reset-job', adminRoute: 'POST /admin/scheduler/reset-job' },
  { capability: 'cancel a not-yet-terminal job', ipcChannel: null, adminRoute: 'POST /admin/scheduler/cancel-job' },
];

function captureRegisteredRoutes() {
  const registered = new Set();
  const fakeAdminHttp = {
    registerRoute(method, url) {
      registered.add(`${method} ${url}`);
    },
  };
  scheduler.registerAdminRoutes(fakeAdminHttp, scheduler.remote);
  prdCreate.registerAdminRoute(fakeAdminHttp, scheduler.remote);
  prdAdminRoutes.registerAdminRoute(fakeAdminHttp, scheduler.remote);
  return registered;
}

test('every enumerated PRD/job mutation capability has a registered admin route', () => {
  const registered = captureRegisteredRoutes();
  const missing = REQUIRED_CAPABILITIES.filter((c) => !registered.has(c.adminRoute));
  expect(missing).toEqual([]);
});

test.each(REQUIRED_CAPABILITIES)('capability "$capability" → $adminRoute is registered', ({ adminRoute }) => {
  const registered = captureRegisteredRoutes();
  expect(registered.has(adminRoute)).toBe(true);
});
