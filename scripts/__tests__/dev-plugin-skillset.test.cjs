/**
 * dev-plugin-skillset.test.cjs — pins the session-manager-dev plugin to its
 * three in-use skills. The other twelve were removed (0-6 lifetime uses; their
 * descriptions cost context in every session) and must not creep back.
 *
 * Run: timeout 120 npx vitest run scripts/__tests__/dev-plugin-skillset.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'plugins/session-manager-dev');
const PLUGIN_JSON = path.join(PLUGIN_DIR, '.claude-plugin/plugin.json');
const MARKETPLACE_JSON = path.join(REPO_ROOT, '.claude-plugin/marketplace.json');

const KEPT = ['builder', 'develop', 'send-feedback'];
const REMOVED = [
  'blog-for-project-feature',
  'discover-features',
  'explain-to-me',
  'find-opportunity',
  'issue-address',
  'local-project-health',
  'memory-sanitation',
  'ops-sweep',
  'project-status',
  'pr-review-sweep',
  'pr-signal',
  'requesting-code-review',
];

test('skills dir lists exactly the three kept skills', () => {
  const dirs = fs
    .readdirSync(path.join(PLUGIN_DIR, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  expect(dirs).toEqual(KEPT);
});

test('plugin.json and marketplace.json name no removed skill', () => {
  for (const file of [PLUGIN_JSON, MARKETPLACE_JSON]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of REMOVED) {
      expect(text, `${path.basename(file)} mentions ${name}`).not.toContain(name);
    }
  }
});

test('plugin.json version equals the marketplace entry version', () => {
  const plugin = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
  const market = JSON.parse(fs.readFileSync(MARKETPLACE_JSON, 'utf8'));
  const entry = market.plugins.find((p) => p.name === 'session-manager-dev');
  expect(entry).toBeTruthy();
  expect(plugin.version).toBe(entry.version);
});
