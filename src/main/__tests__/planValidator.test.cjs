/**
 * planValidator.test.cjs — unit tests for hasDownstreamValidator (PRD 1408).
 *
 * Run: timeout 300 npx vitest run src/main/__tests__/planValidator.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { hasDownstreamValidator } = require('../lib/planValidator.cjs');

test('true when a pending validator row depends on the job', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(true);
});

test('true when the depending validator row is running', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'running', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(true);
});

test('false when the job itself is a validator', () => {
  const job = { slug: '999-validate', agentType: 'validator' };
  const jobs = [
    job,
    { slug: '998-other-validate', agentType: 'validator', status: 'pending', dependsOn: ['999-validate'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false for null/undefined job or jobs', () => {
  expect(hasDownstreamValidator(null, [{ slug: 'x' }])).toBe(false);
  expect(hasDownstreamValidator(undefined, [{ slug: 'x' }])).toBe(false);
  expect(hasDownstreamValidator({ slug: '111-alpha' }, null)).toBe(false);
  expect(hasDownstreamValidator({ slug: '111-alpha' }, undefined)).toBe(false);
});

test('false when the validator row does not depend on this job', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['222-beta'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false when the depending row is a completed validator', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-validate', agentType: 'validator', status: 'completed', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false when the depending row is not agentType validator', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '999-other', agentType: 'dev-lead', status: 'pending', dependsOn: ['111-alpha'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('true when a pending validator reaches the job transitively via one sink (2-hop)', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '150-sink', agentType: 'dev-lead', status: 'pending', dependsOn: ['111-alpha'] },
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['150-sink'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(true);
});

test('true when a pending validator reaches the job transitively via two intermediate sinks (3-hop)', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '140-mid', agentType: 'dev-lead', status: 'pending', dependsOn: ['111-alpha'] },
    { slug: '150-sink', agentType: 'dev-lead', status: 'pending', dependsOn: ['140-mid'] },
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['150-sink'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(true);
});

test('false when the validator only reaches an unrelated branch', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '222-beta', agentType: 'dev-lead', status: 'pending', dependsOn: [] },
    { slug: '150-sink', agentType: 'dev-lead', status: 'pending', dependsOn: ['222-beta'] },
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['150-sink'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('cycle in dependsOn terminates and returns false when the job is not reachable', () => {
  const job = { slug: '111-alpha' };
  const jobs = [
    job,
    { slug: '200-a', agentType: 'dev-lead', status: 'pending', dependsOn: ['201-b'] },
    { slug: '201-b', agentType: 'dev-lead', status: 'pending', dependsOn: ['200-a'] },
    { slug: '999-validate', agentType: 'validator', status: 'pending', dependsOn: ['200-a'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});

test('false when a same-named validator/sink pair belongs to a different project (cwd)', () => {
  const job = { slug: '011-alpha', cwd: '/projectA' };
  const jobs = [
    job,
    { slug: '012-sink', cwd: '/projectA', agentType: 'dev-lead', status: 'pending', dependsOn: [] },
    { slug: '512-sink', cwd: '/projectB', agentType: 'dev-lead', status: 'pending', dependsOn: ['011-alpha'] },
    { slug: '999-validate', cwd: '/projectB', agentType: 'validator', status: 'pending', dependsOn: ['sink'] },
  ];
  expect(hasDownstreamValidator(job, jobs)).toBe(false);
});
