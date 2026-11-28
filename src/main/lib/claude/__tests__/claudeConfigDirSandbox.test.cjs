'use strict';

import { describe, it, expect } from 'vitest';
const os = require('node:os');
const path = require('node:path');
const { claudeJsonPath } = require('../claudeJsonApproval.cjs');

describe('vitest setup sandboxes CLAUDE_CONFIG_DIR', () => {
  it('points CLAUDE_CONFIG_DIR under os.tmpdir(), away from the real ~/.claude.json', () => {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    expect(dir).toBeTruthy();
    const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
    expect(rel && !rel.startsWith('..') && !path.isAbsolute(rel)).toBe(true);
    expect(claudeJsonPath()).not.toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('places CLAUDE_CONFIG_DIR inside the globalSetup sandbox when one is set', () => {
    const sandbox = process.env.SM_SANDBOX_DIR;
    if (!sandbox) return;
    const rel = path.relative(path.resolve(sandbox), path.resolve(process.env.CLAUDE_CONFIG_DIR));
    expect(rel && !rel.startsWith('..') && !path.isAbsolute(rel)).toBe(true);
  });
});
