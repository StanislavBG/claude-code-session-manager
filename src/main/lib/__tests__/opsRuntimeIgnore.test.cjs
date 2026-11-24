'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ensureRuntimeIgnores, ensureRuntimeIgnoreForPath, RUNTIME_NAMESPACES, checkOpsWrite,
} = require('../opsOwnership.cjs');

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
    put('plan-records/epic-1/3579-x.md');
    put('reviews/validation/r.md');
    const written = ensureRuntimeIgnores(root);
    expect(written.length).toBe(3);
    expect(fs.existsSync(path.join(ops, 'logs'))).toBe(false);
    const st = git(root, 'status', '--porcelain', '-uall');
    expect(st).not.toMatch(/scheduler|ui-prefs|plan-records/);
    expect(st).toMatch(/reviews\/validation\/r\.md/);
    git(root, 'check-ignore', '-q', 'session-manager-operations/scheduler/state/x.jsonl');
    git(root, 'check-ignore', '-q', 'session-manager-operations/plan-records/epic-1/3579-x.md');
    expect(() => git(root, 'check-ignore', '-q', 'session-manager-operations/reviews/validation/r.md')).toThrow();
    expect(ensureRuntimeIgnores(root)).toEqual([]);
  });

  it('writes every namespace self-ignore, feedback/ included', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsign-all-'));
    git(root, 'init', '-q');
    const ops = path.join(root, 'session-manager-operations');
    for (const ns of RUNTIME_NAMESPACES) {
      fs.mkdirSync(path.join(ops, ns), { recursive: true });
      fs.writeFileSync(path.join(ops, ns, 'f.txt'), 'x');
    }
    expect(RUNTIME_NAMESPACES.length).toBe(13);
    const written = ensureRuntimeIgnores(root);
    expect(written.length).toBe(13);
    for (const ns of RUNTIME_NAMESPACES) {
      expect(fs.readFileSync(path.join(ops, ns, '.gitignore'), 'utf8')).toBe('*\n');
    }
    expect(git(root, 'status', '--porcelain', '-uall')).toBe('');
    for (const ns of ['feedback', 'events', 'artifacts']) {
      git(root, 'check-ignore', '-q', `session-manager-operations/${ns}/f.txt`);
    }
  });

  it('isolates a failing namespace and names it in one error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsign-fail-'));
    const ops = path.join(root, 'session-manager-operations');
    for (const ns of RUNTIME_NAMESPACES) fs.mkdirSync(path.join(ops, ns), { recursive: true });
    // A directory sits where events/.gitignore should go: the write fails.
    fs.mkdirSync(path.join(ops, 'events', '.gitignore'));
    let err = null;
    try { ensureRuntimeIgnores(root); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/runtime self-ignore failed: events: /);
    for (const ns of RUNTIME_NAMESPACES.filter((n) => n !== 'events')) {
      expect(fs.statSync(path.join(ops, ns, '.gitignore')).isFile()).toBe(true);
    }
  });

  it('ensureRuntimeIgnoreForPath handles runtime, authored and outside paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsign-path-'));
    const ops = path.join(root, 'session-manager-operations');
    const art = ensureRuntimeIgnoreForPath(path.join(ops, 'artifacts', 'epic-1', 'clip.mp4'));
    expect(art).toBe(path.join(ops, 'artifacts', '.gitignore'));
    expect(fs.readFileSync(art, 'utf8')).toBe('*\n');
    expect(ensureRuntimeIgnoreForPath(path.join(ops, 'artifacts', 'epic-1', 'b.mp4'))).toBeNull();
    expect(ensureRuntimeIgnoreForPath(path.join(ops, 'reviews', 'r.md'))).toBeNull();
    expect(fs.existsSync(path.join(ops, 'reviews'))).toBe(false);
    expect(ensureRuntimeIgnoreForPath(path.join(root, 'src', 'x.js'))).toBeNull();
    expect(ensureRuntimeIgnoreForPath(path.join(ops, 'logs', '.gitignore'))).toBeNull();
    expect(fs.existsSync(path.join(ops, 'logs'))).toBe(false);
  });

  it('owner-less feedback/ accepts only its declared delegation', () => {
    const P = '/r/session-manager-operations/feedback';
    expect(checkOpsWrite(`${P}/.gitignore`, 'runtime-ignore').ok).toBe(true);
    expect(checkOpsWrite(`${P}/.gitignore`, 'scheduler').ok).toBe(false);
    expect(checkOpsWrite(`${P}/.gitignore`, undefined).ok).toBe(false);
    for (const w of ['runtime-ignore', 'scheduler', undefined]) {
      expect(checkOpsWrite(`${P}/notes.md`, w).ok).toBe(false);
    }
  });
});
