'use strict';

import { test, expect } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../config.cjs');

test('allowed root removal: validatePath refuses again, unknown returns false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-allowed-root-'));
  try {
    const child = path.join(dir, 'x.txt');
    config.addAllowedRoot(dir);
    expect(() => config.validatePath(child)).not.toThrow();
    expect(config.removeAllowedRoot(dir)).toBe(true);
    if (!path.resolve(dir).startsWith(path.resolve(os.homedir()) + path.sep)) {
      expect(() => config.validatePath(child)).toThrow(/outside allowed/);
    }
    expect(config.removeAllowedRoot(dir)).toBe(false);
    expect(config.removeAllowedRoot(path.join(dir, 'never-added'))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('allowed root removal never removes the home root', () => {
  expect(config.removeAllowedRoot(os.homedir())).toBe(false);
  expect(config.getAllowedRoots()).toContain(os.homedir());
});
