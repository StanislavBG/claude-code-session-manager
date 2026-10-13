/**
 * memoryDirResolve.cjs — where Claude Code itself keeps memory.
 *
 * Pure resolver (all IO injected) so the Memory tab reads and writes exactly the native locations:
 *   - workspace memory: ~/.claude/projects/<encoded git-repo root>/memory/ (all worktrees of a
 *     repo share it), unless the `autoMemoryDirectory` setting overrides it.
 *   - subagent memory: enabled by a `memory:` frontmatter field on the agent.
 *
 * Top-level in lib/ because it spans settings, git and agent files (no single domain folder fits).
 */
'use strict';

const path = require('node:path');
const { encodeCwd } = require('./util/encodeCwd.cjs');

const SCOPES = ['user', 'project', 'local'];
const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Highest-precedence value (local > project > user) of `key` passing `pred`. */
function pick(settings, key, pred) {
  for (const layer of ['local', 'project', 'user']) {
    const s = settings && settings[layer];
    if (s && typeof s === 'object' && pred(s[key])) return s[key];
  }
  return undefined;
}

function expandDir(value, home, cwd) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return path.resolve(cwd, value);
}

function resolveWorkspaceMemoryDir({ home, cwd, settings, repoRoot }) {
  const override = pick(settings, 'autoMemoryDirectory', (v) => typeof v === 'string' && v.trim() !== '');
  if (override !== undefined) {
    return { dir: expandDir(override.trim(), home, cwd), source: 'autoMemoryDirectory' };
  }
  return {
    dir: path.join(home, '.claude', 'projects', encodeCwd(repoRoot || cwd), 'memory'),
    source: 'default',
  };
}

function autoMemoryEnabled(settings) {
  return pick(settings, 'autoMemoryEnabled', (v) => typeof v === 'boolean') !== false;
}

function resolveAgentMemoryDir({ home, root, name, scope }) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw new Error(`invalid agent name: ${JSON.stringify(name)}`);
  }
  if (!SCOPES.includes(scope)) throw new Error(`unknown memory scope: ${JSON.stringify(scope)}`);
  if (scope === 'user') return path.join(home, '.claude', 'agent-memory', name);
  if (typeof root !== 'string' || !root) throw new Error(`scope '${scope}' requires a project root`);
  return path.join(root, '.claude', scope === 'project' ? 'agent-memory' : 'agent-memory-local', name);
}

/** Parse the leading `---` block into a flat key -> string map. */
function parseFrontmatter(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0].trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return out;
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return {}; // unterminated block: not frontmatter
}

function scanAgents(dir, origin, readDir, readText) {
  let names;
  try {
    names = readDir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const file of names || []) {
    if (typeof file !== 'string' || !file.endsWith('.md')) continue;
    const agentFile = path.join(dir, file);
    let text;
    try {
      text = readText(agentFile);
    } catch {
      continue;
    }
    if (text == null) continue;
    const fm = parseFrontmatter(text);
    out.push({
      name: fm.name || file.slice(0, -3),
      origin,
      memoryScope: SCOPES.includes(fm.memory) ? fm.memory : null,
      agentFile,
    });
  }
  return out;
}

function listMemoryAgents({ home, root, readDir, readText }) {
  const byName = new Map();
  for (const a of scanAgents(path.join(home, '.claude', 'agents'), 'user', readDir, readText)) byName.set(a.name, a);
  if (root) {
    for (const a of scanAgents(path.join(root, '.claude', 'agents'), 'project', readDir, readText)) byName.set(a.name, a);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

const rootCache = new Map();

function gitRepoRoot(cwd, execFileSync) {
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let root = null;
  try {
    const out = String(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd,
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ).trim();
    if (out.endsWith('/.git')) root = out.slice(0, -'/.git'.length) || null;
  } catch {
    root = null;
  }
  rootCache.set(cwd, root);
  return root;
}

module.exports = {
  resolveWorkspaceMemoryDir,
  autoMemoryEnabled,
  resolveAgentMemoryDir,
  listMemoryAgents,
  gitRepoRoot,
};
