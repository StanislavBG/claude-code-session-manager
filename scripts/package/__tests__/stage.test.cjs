import { describe, it, expect } from 'vitest';
const nodePath = require('node:path');
const { stagePackageJson, npmInvocation } = require('../stage.cjs');

const rootPkg = () => ({
  name: 'x',
  version: '1.0.0',
  main: 'src/main/index.cjs',
  os: ['darwin', 'linux'],
  dependencies: { electron: '^42.0.0', '@electron/rebuild': '^3.0.0', 'node-pty': '^1.0.0' },
  devDependencies: { vitest: '^1' },
  scripts: { postinstall: 'node scripts/postinstall.cjs', build: 'vite build' },
});

describe('stagePackageJson', () => {
  it('removes electron and @electron/rebuild but keeps other deps', () => {
    const out = stagePackageJson(rootPkg());
    expect(out.dependencies).toEqual({ 'node-pty': '^1.0.0' });
  });
  it('drops devDependencies, scripts, and os; keeps main', () => {
    const out = stagePackageJson(rootPkg());
    expect(out.devDependencies).toBeUndefined();
    expect(out.scripts).toEqual({});
    expect('os' in out).toBe(false);
    expect(out.main).toBe('src/main/index.cjs');
  });
  it('does not mutate its input', () => {
    const input = rootPkg();
    stagePackageJson(input);
    expect(input).toEqual(rootPkg());
  });
});

describe('assertNoStagedElectron', () => {
  const { assertNoStagedElectron } = require('../stage.cjs');
  const fs = require('node:fs');
  const os = require('node:os');
  it('returns null when node_modules/electron is absent', () => {
    const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'stage-t-'));
    try {
      fs.mkdirSync(nodePath.join(d, 'node_modules', 'node-pty'), { recursive: true });
      expect(assertNoStagedElectron(d)).toBeNull();
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  it('returns a diagnostic when node_modules/electron exists', () => {
    const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'stage-t-'));
    try {
      fs.mkdirSync(nodePath.join(d, 'node_modules', 'electron'), { recursive: true });
      expect(assertNoStagedElectron(d)).toMatch(/electron/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('npmInvocation', () => {
  it('uses node + npm_execpath when it is a .js/.cjs file', () => {
    expect(npmInvocation({ npm_execpath: '/x/npm-cli.js' }, 'win32')).toEqual({
      command: process.execPath,
      args: ['/x/npm-cli.js'],
    });
    expect(npmInvocation({ npm_execpath: '/x/npm.cjs' }, 'linux')).toEqual({
      command: process.execPath,
      args: ['/x/npm.cjs'],
    });
  });
  it('on win32 without npm_execpath runs npm-cli.js beside the node binary', () => {
    expect(npmInvocation({}, 'win32')).toEqual({
      command: process.execPath,
      args: [
        nodePath.join(nodePath.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ],
    });
  });
  it('on POSIX without npm_execpath falls back to bare npm', () => {
    expect(npmInvocation({}, 'linux')).toEqual({ command: 'npm', args: [] });
  });
});
