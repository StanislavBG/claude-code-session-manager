/**
 * package-files.test.cjs — packaging regression test. Ensures
 * scripts/scheduler-mcp-server.cjs (and any future required file) is never
 * silently dropped from package.json's "files" array again, since a dropped
 * file means the scheduler_create_prd MCP tool can never register on any
 * machine that installed via npx.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/package-files.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const REQUIRED_PATHS = ['scripts/scheduler-mcp-server.cjs'];

test(
  'npm pack --dry-run includes every file required by the scheduler MCP server',
  () => {
    const raw = execFileSync(
      'npm',
      ['pack', '--dry-run', '--ignore-scripts', '--json'],
      { cwd: REPO_ROOT, timeout: 240000, encoding: 'utf8' },
    );
    const [{ files }] = JSON.parse(raw);
    const packedPaths = new Set(files.map((f) => f.path));

    const missing = REQUIRED_PATHS.filter((p) => !packedPaths.has(p));
    expect(
      missing,
      `npm pack is missing required file(s): ${missing.join(', ')}. ` +
        `Add them to package.json's "files" array.`,
    ).toEqual([]);
  },
  240000,
);
