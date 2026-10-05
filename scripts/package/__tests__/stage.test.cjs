import { describe, it, expect } from 'vitest';
const { stagePackageJson } = require('../stage.cjs');

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
