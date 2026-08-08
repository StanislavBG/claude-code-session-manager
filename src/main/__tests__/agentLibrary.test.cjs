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
const { listPersonas, openProjects, parseTools, savePersona, deletePersona, removeOverride } = require('../agentLibrary.cjs');

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

// savePersona/deletePersona/removeOverride take an injectable writeTextAtomic
// too, since the real config.cjs one enforces its own home-dir validatePath
// regardless of what's injected for the `validatePath` param here.
async function fakeWriteTextAtomic(abs, text) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text, 'utf8');
  return { ok: true, mtimeMs: Date.now() };
}

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
      'tags: feature, bug',
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
  expect(byName.builder.tags).toEqual(['feature', 'bug']);
  expect(byName.debugger.tags).toEqual([]);
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

test('savePersona writes frontmatter + body, and rejects a non-slug name', async () => {
  const globalDir = await mkTmp('sm-agent-library-save-');
  await savePersona({
    name: 'my-agent',
    description: 'Does a thing.',
    tools: ['Read', 'Grep'],
    model: 'opus',
    color: 'blue',
    tags: ['feature', 'bug'],
    body: 'You are my-agent.',
    globalDir,
    validatePath: identityValidatePath,
    writeTextAtomic: fakeWriteTextAtomic,
  });
  const text = await fsp.readFile(path.join(globalDir, 'my-agent.md'), 'utf8');
  expect(text).toContain('name: my-agent');
  expect(text).toContain('description: Does a thing.');
  expect(text).toContain('tools: Read, Grep');
  expect(text).toContain('model: opus');
  expect(text).toContain('color: blue');
  expect(text).toContain('tags: feature, bug');
  expect(text).toContain('You are my-agent.');

  await expect(
    savePersona({ name: 'Not Valid', body: '', globalDir, validatePath: identityValidatePath, writeTextAtomic: fakeWriteTextAtomic }),
  ).rejects.toThrow(/lowercase, hyphenated/);
});

test('savePersona with originalName renames — writes the new file and removes the old one', async () => {
  const globalDir = await mkTmp('sm-agent-library-rename-');
  await fsp.writeFile(path.join(globalDir, 'old-name.md'), '---\nname: old-name\n---\nBody.\n');
  await savePersona({
    name: 'new-name',
    originalName: 'old-name',
    description: '',
    tools: [],
    model: 'inherit',
    color: '',
    body: 'Body.',
    globalDir,
    validatePath: identityValidatePath,
    writeTextAtomic: fakeWriteTextAtomic,
  });
  expect(fs.existsSync(path.join(globalDir, 'new-name.md'))).toBe(true);
  expect(fs.existsSync(path.join(globalDir, 'old-name.md'))).toBe(false);
});

test('deletePersona removes the file, and is a no-op when it is already gone', async () => {
  const globalDir = await mkTmp('sm-agent-library-delete-');
  await fsp.writeFile(path.join(globalDir, 'gone-soon.md'), '---\nname: gone-soon\n---\nBody.\n');
  await deletePersona({ name: 'gone-soon', globalDir, validatePath: identityValidatePath });
  expect(fs.existsSync(path.join(globalDir, 'gone-soon.md'))).toBe(false);
  await expect(deletePersona({ name: 'gone-soon', globalDir, validatePath: identityValidatePath })).resolves.toEqual({ ok: true });
});

test('removeOverride deletes a project overlay resolved by project name, and rejects an unknown project', async () => {
  const project = await mkTmp('sm-agent-library-override-');
  await fsp.mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
  const overlayPath = path.join(project, '.claude', 'agents', 'builder.md');
  await fsp.writeFile(overlayPath, 'overlay\n');
  const loadSessions = async () => ({ tabs: [{ cwd: project }] });

  await removeOverride({ name: 'builder', projectName: path.basename(project), loadSessions, validatePath: identityValidatePath });
  expect(fs.existsSync(overlayPath)).toBe(false);

  await expect(
    removeOverride({ name: 'builder', projectName: 'not-open', loadSessions, validatePath: identityValidatePath }),
  ).rejects.toThrow(/project not open/);
});

test('projects/action/actionLabel round-trip through savePersona -> listPersonas, with newlines preserved', async () => {
  const globalDir = await mkTmp('sm-agent-library-action-');
  const action = '/builder\n\nCheck git vs the published package and publish anything new.';
  await savePersona({
    name: 'builder',
    description: 'Drives the next publish.',
    tools: ['Bash'],
    model: 'inherit',
    color: '',
    tags: ['build'],
    projects: ['/home/bilko/Projects/alpha', '/home/bilko/Projects/beta'],
    action,
    actionLabel: 'Run Build',
    body: 'Body.',
    globalDir,
    validatePath: identityValidatePath,
    writeTextAtomic: fakeWriteTextAtomic,
  });

  // The frontmatter parser is line-based, so the multi-line action must be
  // stored escaped — a raw newline would silently truncate it on read.
  const raw = await fsp.readFile(path.join(globalDir, 'builder.md'), 'utf8');
  expect(raw).toContain('action: /builder\\n\\nCheck git');
  expect(raw).toContain('projects: /home/bilko/Projects/alpha, /home/bilko/Projects/beta');

  const [p] = await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: identityValidatePath });
  expect(p.projects).toEqual(['/home/bilko/Projects/alpha', '/home/bilko/Projects/beta']);
  expect(p.action).toBe(action);
  expect(p.actionLabel).toBe('Run Build');
});

test('a persona with no Action fields reports them as empty/null rather than undefined', async () => {
  const globalDir = await mkTmp('sm-agent-library-noaction-');
  await fsp.writeFile(path.join(globalDir, 'plain.md'), '---\nname: plain\n---\nBody.\n');
  const [p] = await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: identityValidatePath });
  expect(p.projects).toEqual([]);
  expect(p.action).toBeNull();
  expect(p.actionLabel).toBeNull();
});
