'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ensureRuntimeIgnores } = require('../opsOwnership.cjs');

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

describe('ensureRuntimeIgnores', () => {
  it('ignores runtime namespaces only, idempotently', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsign-'));
    git(root, 'init', '-q');
    const ops = path.join(root, 'session-manager-operations');
    const put = (rel) => {
      const f = path.join(ops, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x');
    };
    put('scheduler/state/x.jsonl');
    put('ui-prefs/prefs.json');
    put('reviews/validation/r.md');
    const written = ensureRuntimeIgnores(root);
    expect(written.length).toBe(2);
    expect(fs.existsSync(path.join(ops, 'logs'))).toBe(false);
    const st = git(root, 'status', '--porcelain', '-uall');
    expect(st).not.toMatch(/scheduler|ui-prefs/);
    expect(st).toMatch(/reviews\/validation\/r\.md/);
    git(root, 'check-ignore', '-q', 'session-manager-operations/scheduler/state/x.jsonl');
    expect(() => git(root, 'check-ignore', '-q', 'session-manager-operations/reviews/validation/r.md')).toThrow();
    expect(ensureRuntimeIgnores(root)).toEqual([]);
  });
});
