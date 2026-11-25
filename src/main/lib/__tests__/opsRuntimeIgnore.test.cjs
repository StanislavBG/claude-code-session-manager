'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ensureRuntimeIgnore, ensureRuntimeIgnores, ensureRuntimeIgnoreForPath, RUNTIME_NAMESPACES, checkOpsWrite,
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

  it('writes exactly the 12 runtime self-ignores, never feedback/ or project-pages/', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsign-all-'));
    git(root, 'init', '-q');
    const ops = path.join(root, 'session-manager-operations');
    for (const ns of [...RUNTIME_NAMESPACES, 'feedback', 'project-pages']) {
      fs.mkdirSync(path.join(ops, ns), { recursive: true });
      fs.writeFileSync(path.join(ops, ns, 'f.txt'), 'x');
    }
    expect(RUNTIME_NAMESPACES.length).toBe(12);
    const written = ensureRuntimeIgnores(root);
    expect(written.length).toBe(12);
    for (const ns of RUNTIME_NAMESPACES) {
      expect(fs.readFileSync(path.join(ops, ns, '.gitignore'), 'utf8')).toBe('*\n');
    }
    expect(fs.existsSync(path.join(ops, 'feedback', '.gitignore'))).toBe(false);
    expect(fs.existsSync(path.join(ops, 'project-pages', '.gitignore'))).toBe(false);
    const st = git(root, 'status', '--porcelain', '-uall').split('\n').filter(Boolean).sort();
    expect(st).toEqual([
      '?? session-manager-operations/feedback/f.txt',
      '?? session-manager-operations/project-pages/f.txt',
    ]);
    for (const ns of ['events', 'artifacts']) {
      git(root, 'check-ignore', '-q', `session-manager-operations/${ns}/f.txt`);
    }
    for (const ns of ['feedback', 'project-pages']) {
      expect(() => git(root, 'check-ignore', '-q', `session-manager-operations/${ns}/f.txt`)).toThrow();
    }
  });

  it('a project feedback/ is never self-ignored; non-runtime namespaces throw', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsign-fb-'));
    const ops = path.join(root, 'session-manager-operations');
    expect(ensureRuntimeIgnoreForPath(path.join(ops, 'feedback', 'item.md'))).toBeNull();
    expect(fs.existsSync(path.join(ops, 'feedback'))).toBe(false);
    fs.mkdirSync(path.join(ops, 'feedback'), { recursive: true });
    fs.mkdirSync(path.join(ops, 'project-pages'), { recursive: true });
    expect(() => ensureRuntimeIgnore(root, 'feedback')).toThrow(/not a runtime namespace/);
    expect(() => ensureRuntimeIgnore(root, 'project-pages')).toThrow(/not a runtime namespace/);
    expect(fs.existsSync(path.join(ops, 'feedback', '.gitignore'))).toBe(false);
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

  it('owner-less feedback/ refuses every write, its .gitignore included', () => {
    const P = '/r/session-manager-operations/feedback';
    for (const w of ['runtime-ignore', 'scheduler', undefined]) {
      expect(checkOpsWrite(`${P}/.gitignore`, w).ok).toBe(false);
      expect(checkOpsWrite(`${P}/notes.md`, w).ok).toBe(false);
    }
  });
});
