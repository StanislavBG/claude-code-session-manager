'use strict';

import { describe, it, expect } from 'vitest';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { relaunchSpec, defaultSpawnRelaunch } = require('../watchdogHelpers.cjs');
const { resolveInstallChannel } = require('../machineProfile.cjs');

describe('packaged relaunch + install channel', () => {
  it('relaunchSpec uses the app binary when packaged', () => {
    expect(relaunchSpec({ packaged: true, execPath: '/app/bin' })).toEqual({
      command: '/app/bin', args: [], packaged: true,
    });
  });

  it('relaunchSpec keeps npx when not packaged', () => {
    const spec = relaunchSpec({ packaged: false });
    expect(spec.command).toBe('npx');
    expect(spec.args).toEqual(['claude-code-session-manager@latest']);
  });

  it('defaultSpawnRelaunch never spawns npx when packaged', () => {
    const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkgrl-')), 'r.log');
    const calls = [];
    const spawnFn = (cmd, args, o) => { calls.push({ cmd, args, o }); return { on() {}, unref() {} }; };
    defaultSpawnRelaunch({ logPath, packaged: true, execPath: '/app/bin', spawnFn });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('/app/bin');
    expect(calls[0].args).toEqual([]);
    expect(calls[0].o.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('install channel is installer when packaged, before the _npx heuristic', () => {
    expect(resolveInstallChannel({ packaged: true, appPath: '/home/u/.npm/_npx/abc/x', devFlag: false })).toBe('installer');
  });

  it('install channel falls back to npx heuristic when not packaged', () => {
    expect(resolveInstallChannel({ packaged: false, appPath: '/home/u/.npm/_npx/abc/x', devFlag: false })).toBe('npx');
  });
});
