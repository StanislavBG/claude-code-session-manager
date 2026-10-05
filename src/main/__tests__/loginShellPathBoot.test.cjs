'use strict';

import { describe, it, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.cjs'), 'utf8');

describe('login-shell PATH boot wiring', () => {
  const requireIdx = src.indexOf("require('./lib/loginShellPath.cjs')");
  const callIdx = src.indexOf('applyLoginShellPath(');
  const assignIdx = src.indexOf('bootClaudeBin = { resolved: claudeResolved');

  it('requires the helper and calls it exactly once', () => {
    expect(requireIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(-1);
    expect(src.split('applyLoginShellPath(').length - 1).toBe(1);
  });

  it('require + call precede the bootClaudeBin assignment', () => {
    expect(assignIdx).toBeGreaterThan(-1);
    expect(requireIdx).toBeLessThan(assignIdx);
    expect(callIdx).toBeLessThan(assignIdx);
  });

  it('call is guarded by the win32 / SM_SKIP_LOGIN_SHELL_PATH check', () => {
    const guardIdx = src.lastIndexOf("process.platform !== 'win32'", callIdx);
    const envIdx = src.lastIndexOf("SM_SKIP_LOGIN_SHELL_PATH !== '1'", callIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(-1);
    expect(callIdx - Math.min(guardIdx, envIdx)).toBeLessThan(300);
  });

  it('call is wrapped in try/catch so a throw never blocks boot', () => {
    const tryIdx = src.lastIndexOf('try {', callIdx);
    expect(callIdx - tryIdx).toBeLessThan(400);
    expect(src.indexOf('catch', callIdx)).toBeLessThan(assignIdx);
  });
});
