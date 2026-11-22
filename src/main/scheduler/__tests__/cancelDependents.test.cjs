/**
 * cancelDependents.test.cjs — pure planning for remote.cancelJob's dependents
 * choice (PRD 3499): which pending rows depend on the cancelled one, the
 * transitive cascade set, and repoint/clear edits + validation.
 *
 * Run: timeout 120 npx vitest run src/main/scheduler/__tests__/cancelDependents.test.cjs
 */
'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const cd = require('../cancelDependents.cjs');

const A = '/proj/a';
const B = '/proj/b';
const row = (slug, extra = {}) => ({ slug, cwd: A, status: 'pending', epicId: 'e1', dependsOn: [], ...extra });

test('findPendingDependents: exact and bare matches count', () => {
  const jobs = [
    row('10-target'),
    row('11-exact', { dependsOn: ['10-target'] }),
    row('12-bare', { dependsOn: ['target'] }),
    row('13-other', { dependsOn: ['unrelated'] }),
  ];
  const got = cd.findPendingDependents(jobs, '10-target', A);
  assert.deepEqual(got.map((d) => d.slug), ['11-exact', '12-bare']);
  assert.deepEqual(got[1].deps, ['target']);
});

test('findPendingDependents: own cwd only, pending only', () => {
  const jobs = [
    row('10-target'),
    row('11-other-cwd', { cwd: B, dependsOn: ['10-target'] }),
    row('12-done', { status: 'completed', dependsOn: ['10-target'] }),
    row('13-running', { status: 'running', dependsOn: ['10-target'] }),
    row('14-live', { dependsOn: ['target'] }),
  ];
  assert.deepEqual(cd.findPendingDependents(jobs, '10-target', A).map((d) => d.slug), ['14-live']);
  assert.deepEqual(cd.findPendingDependents(jobs, '10-target', B), []);
});

test('findPendingDependents: a bare dep that resolves to a same-Epic twin is not a dependent', () => {
  const jobs = [
    row('10-target', { epicId: 'e1' }),
    row('20-target', { epicId: 'e2' }),
    row('21-dep', { epicId: 'e2', dependsOn: ['target'] }),
  ];
  assert.deepEqual(cd.findPendingDependents(jobs, '10-target', A), []);
  assert.deepEqual(cd.findPendingDependents(jobs, '20-target', A).map((d) => d.slug), ['21-dep']);
});

test('planDependentsUpdate cascade: transitive set, reason names the root', () => {
  const jobs = [
    row('10-target'),
    row('11-a', { dependsOn: ['target'] }),
    row('12-b', { dependsOn: ['11-a'] }),
    row('13-c', { dependsOn: ['b', '11-a'] }),
    row('14-x'),
  ];
  const plan = cd.planDependentsUpdate(jobs, '10-target', { action: 'cascade' }, A);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.dependents, ['11-a', '12-b', '13-c']);
  for (const e of plan.edits) {
    assert.equal(e.action, 'cancel');
    assert.match(e.reason, /10-target/);
  }
});

test('planDependentsUpdate clear: drops only the dep on the target', () => {
  const jobs = [row('10-target'), row('09-keep'), row('11-a', { dependsOn: ['09-keep', 'target'] })];
  const plan = cd.planDependentsUpdate(jobs, '10-target', { action: 'clear' }, A);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.edits, [{ slug: '11-a', action: 'setDependsOn', dependsOn: ['09-keep'], previous: ['09-keep', 'target'] }]);
});

test('planDependentsUpdate repoint: resolves `to` to its full NN slug and dedups', () => {
  const jobs = [row('10-target'), row('15-replacement'), row('11-a', { dependsOn: ['target', '15-replacement'] }), row('12-b', { dependsOn: ['10-target'] })];
  const plan = cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint', to: 'replacement' }, A);
  assert.equal(plan.ok, true);
  assert.equal(plan.to, '15-replacement');
  assert.deepEqual(plan.edits.map((e) => [e.slug, e.dependsOn]), [['11-a', ['15-replacement']], ['12-b', ['15-replacement']]]);
});

test('planDependentsUpdate repoint validation: unresolved, missing, target, cycle', () => {
  const jobs = [row('10-target'), row('11-a', { dependsOn: ['target'] }), row('12-b', { dependsOn: ['11-a'] })];
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint', to: 'nope' }, A).error, /does not resolve/);
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint' }, A).error, /requires dependents.to/);
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint', to: 'target' }, A).error, /being cancelled/);
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint', to: '12-b' }, A).error, /cycle/);
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint', to: '11-a' }, A).error, /cycle/);
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'nuke' }, A).error, /must be one of/);
});

test('planDependentsUpdate repoint: `to` in another cwd does not resolve', () => {
  const jobs = [row('10-target'), row('11-a', { dependsOn: ['target'] }), row('30-elsewhere', { cwd: B })];
  assert.match(cd.planDependentsUpdate(jobs, '10-target', { action: 'repoint', to: '30-elsewhere' }, A).error, /does not resolve/);
});
