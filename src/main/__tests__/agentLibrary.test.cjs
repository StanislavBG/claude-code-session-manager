/**
 * agentLibrary.test.cjs — unit tests for the Agent Library nav page's
 * backend: enumerating global `~/.claude/agents/*.md` personas and
 * detecting per-project `.claude/agents/<name>.md` overlays among
 * currently-open tabs.
 *
 * Run: timeout 120 npx vitest run src/main/__tests__/agentLibrary.test.cjs
 */

import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { listPersonas, openProjects, parseTools } = require('../agentLibrary.cjs');

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkTmp(prefix) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// listPersonas/openProjects take injectable deps; tests pass an identity
// validatePath since the fixture dirs live under os.tmpdir(), not the real
// home directory config.cjs's validatePath would otherwise enforce.
const identityValidatePath = (p) => p;

test('parseTools splits + trims a comma-separated tools frontmatter value', () => {
  expect(parseTools('Read, Grep, Glob, Bash')).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
  expect(parseTools('')).toEqual([]);
  expect(parseTools(undefined)).toEqual([]);
});

test('openProjects dedups by cwd and uses the last path segment as name', async () => {
  const loadSessions = async () => ({
    tabs: [
      { cwd: '/home/u/Projects/alpha' },
      { cwd: '/home/u/Projects/beta/' },
      { cwd: '/home/u/Projects/alpha' }, // duplicate — should collapse
      { cwd: null }, // malformed — should be skipped
    ],
  });
  const projects = await openProjects({ loadSessions });
  expect(projects).toEqual([
    { cwd: '/home/u/Projects/alpha', name: 'alpha' },
    { cwd: '/home/u/Projects/beta/', name: 'beta' },
  ]);
});

test('listPersonas returns [] when the global agents dir does not exist', async () => {
  const missingDir = path.join(os.tmpdir(), 'sm-agent-library-does-not-exist-' + Date.now());
  const personas = await listPersonas({
    globalDir: missingDir,
    loadSessions: async () => ({ tabs: [] }),
    validatePath: identityValidatePath,
  });
  expect(personas).toEqual([]);
});

test('listPersonas parses frontmatter and reports overridingProjects for open tabs with a local overlay', async () => {
  const globalDir = await mkTmp('sm-agent-library-global-');
  await fsp.writeFile(
    path.join(globalDir, 'builder.md'),
    [
      '---',
      'name: builder',
      'description: Watch git history and drive the next publish.',
      'tools: Read, Grep, Glob, Bash',
      '---',
      '',
      'You are the Builder agent.',
      '',
    ].join('\n'),
  );
  await fsp.writeFile(
    path.join(globalDir, 'debugger.md'),
    ['---', 'name: debugger', 'description: Diagnose a failing test.', '---', '', 'Body.', ''].join('\n'),
  );

  const projectWithOverlay = await mkTmp('sm-agent-library-project-a-');
  await fsp.mkdir(path.join(projectWithOverlay, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(
    path.join(projectWithOverlay, '.claude', 'agents', 'builder.md'),
    '---\nname: builder\n---\nProject-specific overlay.\n',
  );

  const projectWithoutOverlay = await mkTmp('sm-agent-library-project-b-');

  const loadSessions = async () => ({
    tabs: [{ cwd: projectWithOverlay }, { cwd: projectWithoutOverlay }],
  });

  const personas = await listPersonas({ globalDir, loadSessions, validatePath: identityValidatePath });
  expect(personas).toHaveLength(2);

  const byName = Object.fromEntries(personas.map((p) => [p.name, p]));
  expect(byName.builder.description).toBe('Watch git history and drive the next publish.');
  expect(byName.builder.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
  expect(byName.builder.body).toContain('You are the Builder agent.');
  expect(byName.builder.overridingProjects).toEqual([path.basename(projectWithOverlay)]);

  expect(byName.debugger.overridingProjects).toEqual([]);
});

test('listPersonas skips a project cwd that validatePath rejects, rather than throwing', async () => {
  const globalDir = await mkTmp('sm-agent-library-global-');
  await fsp.writeFile(path.join(globalDir, 'builder.md'), '---\nname: builder\n---\nBody.\n');

  const rejectedProject = await mkTmp('sm-agent-library-project-rejected-');
  await fsp.mkdir(path.join(rejectedProject, '.claude', 'agents'), { recursive: true });
  await fsp.writeFile(path.join(rejectedProject, '.claude', 'agents', 'builder.md'), 'overlay\n');

  const loadSessions = async () => ({ tabs: [{ cwd: rejectedProject }] });
  // Simulate config.cjs's validatePath throwing for anything under the
  // rejected project (as it would for a cwd outside the allowed-roots set)
  // while still allowing the global agents dir itself to resolve.
  const selectiveValidatePath = (p) => {
    if (p.startsWith(rejectedProject)) throw new Error('outside allowed boundaries');
    return p;
  };

  const personas = await listPersonas({ globalDir, loadSessions, validatePath: selectiveValidatePath });
  expect(personas).toHaveLength(1);
  expect(personas[0].overridingProjects).toEqual([]);
});
