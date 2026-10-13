'use strict';

import { test } from 'vitest';
const assert = require('node:assert/strict');
const {
  resolveWorkspaceMemoryDir,
  autoMemoryEnabled,
  resolveAgentMemoryDir,
  listMemoryAgents,
  gitRepoRoot,
} = require('../lib/memoryDirResolve.cjs');

const HOME = '/home/u';

test('default dir encodes cwd and falls back to it without a repo root', () => {
  const r = resolveWorkspaceMemoryDir({ home: HOME, cwd: '/a/b.c', settings: {}, repoRoot: null });
  assert.deepEqual(r, { dir: '/home/u/.claude/projects/-a-b-c/memory', source: 'default' });
});

test('worktree cwd maps to the repo-root encoding', () => {
  const r = resolveWorkspaceMemoryDir({ home: HOME, cwd: '/a/repo/wt', settings: null, repoRoot: '/a/repo' });
  assert.equal(r.dir, '/home/u/.claude/projects/-a-repo/memory');
});

test('autoMemoryDirectory precedence local > project > user', () => {
  const settings = {
    user: { autoMemoryDirectory: '/u' },
    project: { autoMemoryDirectory: '/p' },
    local: { autoMemoryDirectory: '/l' },
  };
  const base = { home: HOME, cwd: '/c', repoRoot: null };
  assert.deepEqual(resolveWorkspaceMemoryDir({ ...base, settings }), { dir: '/l', source: 'autoMemoryDirectory' });
  assert.equal(resolveWorkspaceMemoryDir({ ...base, settings: { ...settings, local: null } }).dir, '/p');
  assert.equal(resolveWorkspaceMemoryDir({ ...base, settings: { user: settings.user } }).dir, '/u');
  // non-string values are ignored
  const r = resolveWorkspaceMemoryDir({ ...base, settings: { local: { autoMemoryDirectory: 5 }, user: { autoMemoryDirectory: '/u' } } });
  assert.equal(r.dir, '/u');
});

test('~ expansion and relative resolution', () => {
  const base = { home: HOME, cwd: '/proj', repoRoot: null };
  assert.equal(resolveWorkspaceMemoryDir({ ...base, settings: { user: { autoMemoryDirectory: '~/mem' } } }).dir, '/home/u/mem');
  assert.equal(resolveWorkspaceMemoryDir({ ...base, settings: { user: { autoMemoryDirectory: '~' } } }).dir, '/home/u');
  assert.equal(resolveWorkspaceMemoryDir({ ...base, settings: { user: { autoMemoryDirectory: 'rel/m' } } }).dir, '/proj/rel/m');
});

test('autoMemoryEnabled honors highest-precedence boolean', () => {
  assert.equal(autoMemoryEnabled({}), true);
  assert.equal(autoMemoryEnabled(null), true);
  assert.equal(autoMemoryEnabled({ user: { autoMemoryEnabled: false } }), false);
  assert.equal(autoMemoryEnabled({ user: { autoMemoryEnabled: false }, local: { autoMemoryEnabled: true } }), true);
  assert.equal(autoMemoryEnabled({ project: { autoMemoryEnabled: false }, user: { autoMemoryEnabled: true } }), false);
  assert.equal(autoMemoryEnabled({ local: { autoMemoryEnabled: 'no' } }), true);
});

test('resolveAgentMemoryDir scopes and throw cases', () => {
  assert.equal(resolveAgentMemoryDir({ home: HOME, root: '/r', name: 'x', scope: 'user' }), '/home/u/.claude/agent-memory/x');
  assert.equal(resolveAgentMemoryDir({ home: HOME, root: '/r', name: 'x', scope: 'project' }), '/r/.claude/agent-memory/x');
  assert.equal(resolveAgentMemoryDir({ home: HOME, root: '/r', name: 'x', scope: 'local' }), '/r/.claude/agent-memory-local/x');
  assert.equal(resolveAgentMemoryDir({ home: HOME, name: 'x', scope: 'user' }), '/home/u/.claude/agent-memory/x');
  for (const name of ['', '../x', 'a/b', 'a b', 'x'.repeat(129), null, '..']) {
    if (name === '..') continue; // '..' matches the charset; handled below
    assert.throws(() => resolveAgentMemoryDir({ home: HOME, root: '/r', name, scope: 'user' }));
  }
  assert.throws(() => resolveAgentMemoryDir({ home: HOME, root: '/r', name: '..', scope: 'user' }));
  assert.throws(() => resolveAgentMemoryDir({ home: HOME, root: '/r', name: 'x', scope: 'bogus' }));
  assert.throws(() => resolveAgentMemoryDir({ home: HOME, name: 'x', scope: 'project' }));
  assert.throws(() => resolveAgentMemoryDir({ home: HOME, root: '', name: 'x', scope: 'local' }));
});

function fakeFs(files) {
  return {
    readDir: (d) => {
      const prefix = d.endsWith('/') ? d : d + '/';
      const out = Object.keys(files).filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
      if (!out.length) throw new Error('ENOENT');
      return out.map((p) => p.slice(prefix.length));
    },
    readText: (p) => (p in files ? files[p] : null),
  };
}

test('listMemoryAgents parses frontmatter, sorts, and shadows', () => {
  const files = {
    '/home/u/.claude/agents/zed.md': '---\nname: zed\nmemory: user\n---\nbody',
    '/home/u/.claude/agents/shared.md': '---\nname: shared\nmemory: user\n---\n',
    '/home/u/.claude/agents/nomem.md': '---\nname: nomem\ndescription: x\n---\n',
    '/home/u/.claude/agents/badval.md': '---\nname: badval\nmemory: global\n---\n',
    '/home/u/.claude/agents/stem-only.md': '---\nmemory: "local"\n---\n',
    '/home/u/.claude/agents/nofm.md': 'no frontmatter memory: user',
    '/home/u/.claude/agents/unreadable.md': null,
    '/home/u/.claude/agents/notes.txt': 'ignored',
    '/r/.claude/agents/shared.md': '---\nname: shared\nmemory: project\n---\n',
    '/r/.claude/agents/alpha.md': '---\r\nname: alpha\r\nmemory: local\r\n---\r\n',
  };
  const out = listMemoryAgents({ home: HOME, root: '/r', ...fakeFs(files) });
  assert.deepEqual(out.map((a) => a.name), ['alpha', 'badval', 'nofm', 'nomem', 'shared', 'stem-only', 'zed']);
  const by = Object.fromEntries(out.map((a) => [a.name, a]));
  assert.equal(by.alpha.memoryScope, 'local');
  assert.equal(by.alpha.origin, 'project');
  assert.equal(by.alpha.agentFile, '/r/.claude/agents/alpha.md');
  assert.equal(by.badval.memoryScope, null);
  assert.equal(by.nomem.memoryScope, null);
  assert.equal(by.nofm.memoryScope, null);
  assert.equal(by['stem-only'].memoryScope, 'local');
  assert.equal(by.shared.origin, 'project');
  assert.equal(by.shared.memoryScope, 'project');
  assert.equal(by.zed.origin, 'user');
});

test('listMemoryAgents tolerates missing dirs and no root', () => {
  const out = listMemoryAgents({
    home: HOME,
    root: null,
    readDir: () => { throw new Error('ENOENT'); },
    readText: () => { throw new Error('boom'); },
  });
  assert.deepEqual(out, []);
});

test('gitRepoRoot parses, errors to null, and memoizes per cwd', () => {
  let calls = 0;
  let last;
  const exec = (cmd, args, opts) => {
    calls++;
    last = { cmd, args, opts };
    return '/repo/.git\n';
  };
  assert.equal(gitRepoRoot('/memo-a/wt', exec), '/repo');
  assert.equal(gitRepoRoot('/memo-a/wt', exec), '/repo');
  assert.equal(calls, 1);
  assert.equal(last.cmd, 'git');
  assert.deepEqual(last.args, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  assert.equal(last.opts.cwd, '/memo-a/wt');
  assert.equal(last.opts.timeout, 5000);
  assert.equal(gitRepoRoot('/memo-b', () => '/repo/.git/modules/x\n'), null);
  assert.equal(gitRepoRoot('/memo-c', () => { throw new Error('not a repo'); }), null);
});
