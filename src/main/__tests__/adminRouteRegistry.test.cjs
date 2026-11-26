'use strict';
// The one list of loopback admin routes the app registers (adminRouteRegistry.cjs),
// read through a recording fake — exactly what the running app serves.
const { registerAppAdminRoutes } = require('../adminRouteRegistry.cjs');

const EXPECTED = [
  'GET /admin/scheduler/jobs',
  'GET /admin/scheduler/slots',
  'POST /admin/scheduler/release-plan',
  'GET /admin/usage-hold',
  'POST /admin/scheduler/create-prd',
  'GET /admin/scheduler/prds',
  'POST /admin/project-home/write',
  'GET /admin/voices',
  'GET /admin/macros',
  'POST /admin/macros/run',
  'POST /admin/chat/send-prompt',
  'GET /admin/needs-you',
  'POST /admin/feedback/open-session',
  'POST /admin/feedback/reply',
  'GET /admin/customer-feedback/inbox',
  'GET /admin/site-feedback/inbox',
  'POST /admin/artifacts/publish',
  'GET /admin/events',
  'GET /admin/epics',
  'GET /admin/validation-quality',
  'GET /admin/agents',
  'POST /admin/tasks',
  'POST /admin/tasks/switch',
  'POST /admin/project-home/videos/run',
  'GET /admin/project-home/videos/status',
  'POST /admin/project-home/videos/script-switch',
];

function record(deps) {
  const list = [];
  const fake = { registerRoute(method, p) { list.push(`${method} ${p}`); } };
  if (deps === undefined) registerAppAdminRoutes(fake);
  else registerAppAdminRoutes(fake, deps);
  return list;
}

test.each(EXPECTED)('registers %s', (route) => {
  expect(record({ onMacrosChanged: () => {}, onNeedsYouChanged: () => {} })).toContain(route);
});

test('no METHOD path is registered twice', () => {
  const list = record({ onMacrosChanged: () => {}, onNeedsYouChanged: () => {} });
  const dupes = list.filter((r, i) => list.indexOf(r) !== i);
  expect(dupes).toEqual([]);
  expect(new Set(list).size).toBe(list.length);
});

test('deps omitted does not throw', () => {
  expect(() => record()).not.toThrow();
});
