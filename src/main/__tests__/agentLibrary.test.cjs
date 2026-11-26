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

test('openProjects dedups by normalized cwd, returns that cwd, and uses the last path segment as name', async () => {
  const loadSessions = async () => ({
    tabs: [
      { cwd: '/home/u/Projects/alpha' },
      { cwd: '/home/u/Projects/beta/' }, // trailing slash — stripped
      { cwd: '/home/u/Projects/alpha' }, // duplicate — should collapse
      { cwd: '/home/u//Projects/alpha/' }, // same project, un-normalized — should collapse too
      { cwd: '/' }, // root keeps its slash
      { cwd: null }, // malformed — should be skipped
    ],
  });
  const projects = await openProjects({ loadSessions });
  expect(projects).toEqual([
    { cwd: '/home/u/Projects/alpha', name: 'alpha' },
    { cwd: '/home/u/Projects/beta', name: 'beta' },
    { cwd: '/', name: '/' },
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
  // Every detail carries the open project's normalized cwd — the override key; `project` is display-only.
  expect(byName.builder.overrideDetails.map((d) => [d.project, d.cwd])).toEqual([[path.basename(projectWithOverlay), projectWithOverlay]]);

  expect(byName.debugger.overridingProjects).toEqual([]);
  expect(byName.debugger.overrideDetails).toEqual([]);
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
    model: 'opus',
    color: '',
    body: 'Body.',
    globalDir,
    validatePath: identityValidatePath,
    writeTextAtomic: fakeWriteTextAtomic,
  });
  expect(fs.existsSync(path.join(globalDir, 'new-name.md'))).toBe(true);
  expect(fs.existsSync(path.join(globalDir, 'old-name.md'))).toBe(false);
});

test('savePersona without a seedVersion argument carries over an existing stamp', async () => {
  const globalDir = await mkTmp('sm-agent-library-seedversion-');
  await fsp.writeFile(path.join(globalDir, 'stamped-agent.md'), '---\nname: stamped-agent\nseedVersion: 7\n---\nOld body.\n');
  await savePersona({
    name: 'stamped-agent',
    description: 'Edited via the UI.',
    tools: [],
    model: 'opus',
    color: '',
    body: 'New body.',
    globalDir,
    validatePath: identityValidatePath,
    writeTextAtomic: fakeWriteTextAtomic,
  });
  const text = await fsp.readFile(path.join(globalDir, 'stamped-agent.md'), 'utf8');
  // No seedVersion argument was passed above — savePersona must read the
  // existing file's own stamp and carry it forward, not drop it.
  expect(text).toContain('seedVersion: 7');
  expect(text).toContain('New body.');
});

const base = { tools: [], model: 'opus', color: '', validatePath: identityValidatePath, writeTextAtomic: fakeWriteTextAtomic };

test('savePersona re-save without title/projects/action/actionLabel keeps the existing values', async () => {
  const globalDir = await mkTmp('sm-agent-library-carry-');
  await savePersona({ ...base, name: 'carry-agent', description: 'd', body: 'B.', globalDir, title: 'My Title', projects: ['/a/b', '*'], action: 'Do: the "thing"', actionLabel: 'Go' });
  await savePersona({ ...base, name: 'carry-agent', description: 'd2', body: 'B2.', globalDir });
  const [p] = (await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: identityValidatePath })).filter((x) => x.name === 'carry-agent');
  expect(p.title).toBe('My Title');
  expect(p.projects).toEqual(['/a/b', '*']);
  expect(p.action).toBe('Do: the "thing"');
  expect(p.actionLabel).toBe('Go');
});

test('savePersona with an explicit empty projects array clears projects; explicit values win', async () => {
  const globalDir = await mkTmp('sm-agent-library-carry-clear-');
  await savePersona({ ...base, name: 'clear-agent', description: 'd', body: 'B.', globalDir, title: 'T', projects: ['/a'], action: 'A', actionLabel: 'L' });
  await savePersona({ ...base, name: 'clear-agent', description: 'd', body: 'B.', globalDir, projects: [], title: 'T2' });
  const text = await fsp.readFile(path.join(globalDir, 'clear-agent.md'), 'utf8');
  expect(text).not.toContain('projects:');
  expect(text).toContain('title: T2');
  expect(text).toContain('action: A');
  expect(text).toContain('actionLabel: L');
});

test('savePersona for a brand-new persona writes no seedVersion line', async () => {
  const globalDir = await mkTmp('sm-agent-library-seedversion-new-');
  await savePersona({
    name: 'fresh-agent',
    description: 'A new persona.',
    tools: [],
    model: 'opus',
    color: '',
    body: 'Body.',
    globalDir,
    validatePath: identityValidatePath,
    writeTextAtomic: fakeWriteTextAtomic,
  });
  const text = await fsp.readFile(path.join(globalDir, 'fresh-agent.md'), 'utf8');
  // No prior file to carry a stamp from, and none was passed in — a
  // hand-authored persona must never gain a seedVersion line from thin air.
  expect(text).not.toContain('seedVersion:');
});

test('deletePersona removes the file, and is a no-op when it is already gone', async () => {
  const globalDir = await mkTmp('sm-agent-library-delete-');
  await fsp.writeFile(path.join(globalDir, 'gone-soon.md'), '---\nname: gone-soon\n---\nBody.\n');
  await deletePersona({ name: 'gone-soon', globalDir, validatePath: identityValidatePath });
  expect(fs.existsSync(path.join(globalDir, 'gone-soon.md'))).toBe(false);
  await expect(deletePersona({ name: 'gone-soon', globalDir, validatePath: identityValidatePath })).resolves.toEqual({ ok: true });
});

test('deletePersona rejects a traversal name and leaves the file in place', async () => {
  const home = await mkTmp('sm-agent-library-delete-traversal-');
  const globalDir = path.join(home, '.claude', 'agents');
  await fsp.mkdir(globalDir, { recursive: true });
  // `<globalDir>/../../notes/x.md` resolves to `<home>/notes/x.md` — outside the agents dir.
  const victim = path.join(home, 'notes', 'x.md');
  await fsp.mkdir(path.dirname(victim), { recursive: true });
  await fsp.writeFile(victim, 'not a persona\n');
  const validated = [];
  const validatePath = (p) => { validated.push(p); return p; };

  await expect(deletePersona({ name: '../../notes/x', globalDir, validatePath }))
    .rejects.toThrow('agent name must be lowercase, hyphenated (e.g. "my-agent")');
  expect(fs.existsSync(victim)).toBe(true);
  expect(validated).toEqual([]); // the guard runs before any path is built or checked
});

test('removeOverride deletes a project overlay resolved by projectCwd (a trailing-slash cwd too), and rejects an unknown or empty cwd', async () => {
  const project = await mkTmp('sm-agent-library-override-');
  await fsp.mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
  const overlayPath = path.join(project, '.claude', 'agents', 'builder.md');
  await fsp.writeFile(overlayPath, 'overlay\n');
  const loadSessions = async () => ({ tabs: [{ cwd: project }] });
  const remove = (key) => removeOverride({ name: 'builder', ...key, loadSessions, validatePath: identityValidatePath });

  await remove({ projectCwd: project });
  expect(fs.existsSync(overlayPath)).toBe(false);

  await fsp.writeFile(overlayPath, 'overlay\n');
  await remove({ projectCwd: `${project}/` });
  expect(fs.existsSync(overlayPath)).toBe(false);

  // The folder name is display-only, never a key — and the retired key resolves nothing.
  await fsp.writeFile(overlayPath, 'overlay\n');
  await expect(remove({ projectCwd: path.basename(project) })).rejects.toThrow(/project not open/);
  await expect(remove({ projectName: path.basename(project) })).rejects.toThrow(/project not open/);
  await expect(remove({ projectCwd: '/not/open' })).rejects.toThrow('project not open: /not/open');
  await expect(remove({ projectCwd: '' })).rejects.toThrow(/project not open/);
  expect(fs.existsSync(overlayPath)).toBe(true);
});

test('projects/action/actionLabel round-trip through savePersona -> listPersonas, with newlines preserved', async () => {
  const globalDir = await mkTmp('sm-agent-library-action-');
  const action = '/builder\n\nCheck git vs the published package and publish anything new.';
  await savePersona({
    name: 'builder',
    description: 'Drives the next publish.',
    tools: ['Bash'],
    model: 'opus',
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

test('effort: written when set, omitted for inherit/unset, round-trips, and untouched personas gain no line', async () => {
  const globalDir = await mkTmp('sm-agent-library-effort-');
  const base = { tools: [], color: '', tags: [], body: 'B.', globalDir, validatePath: identityValidatePath, writeTextAtomic: fakeWriteTextAtomic };
  await savePersona({ ...base, name: 'with-effort', model: 'opus', effort: 'xhigh' });
  await savePersona({ ...base, name: 'inherit-effort', model: 'opus', effort: 'inherit' });
  await savePersona({ ...base, name: 'unset-effort', model: 'opus' });
  const raw = (n) => fsp.readFile(path.join(globalDir, `${n}.md`), 'utf8');
  expect(await raw('with-effort')).toContain('effort: xhigh');
  expect(await raw('inherit-effort')).not.toContain('effort:');
  expect(await raw('unset-effort')).not.toContain('effort:');

  const ps = await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: identityValidatePath });
  const by = Object.fromEntries(ps.map((p) => [p.name, p]));
  expect(by['with-effort'].effort).toBe('xhigh');
  expect(by['unset-effort'].effort).toBeNull();

  // Untouched save of a no-effort persona (UI maps null -> 'inherit') must not add a line.
  await savePersona({ ...base, name: 'unset-effort', model: 'opus', effort: by['unset-effort'].effort ?? 'inherit' });
  expect(await raw('unset-effort')).not.toContain('effort:');
});

test('agentCli/agentCliModel: round-trip, carry-over on undefined, claude removes, unknown lists null', async () => {
  const globalDir = await mkTmp('sm-agent-library-agentcli-');
  const base = { tools: [], model: 'opus', effort: 'high', color: '', tags: [], body: 'B.', globalDir, validatePath: identityValidatePath, writeTextAtomic: fakeWriteTextAtomic };
  const raw = (n) => fsp.readFile(path.join(globalDir, `${n}.md`), 'utf8');
  const list = async () => Object.fromEntries((await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: identityValidatePath })).map((p) => [p.name, p]));

  await savePersona({ ...base, name: 'cx', agentCli: 'codex', agentCliModel: 'openai/gpt-5' });
  const cx = await raw('cx');
  expect(cx).toContain('effort: high\nagentCli: codex\nagentCliModel: "openai/gpt-5"\n');
  await savePersona({ ...base, name: 'cf', agentCli: 'opencode', agentCliModel: '@cf/meta/llama-3' });
  expect(await raw('cf')).toContain('agentCliModel: "@cf/meta/llama-3"');
  await savePersona({ ...base, name: 'nomodel', agentCli: 'gemini' });
  expect(await raw('nomodel')).toContain('agentCli: gemini');
  expect(await raw('nomodel')).not.toContain('agentCliModel');
  // Model is ignored without a non-Claude CLI.
  await savePersona({ ...base, name: 'plain', agentCliModel: 'openai/gpt-5' });
  expect(await raw('plain')).not.toContain('agentCli');

  let by = await list();
  expect(by.cx.agentCli).toBe('codex');
  expect(by.cx.agentCliModel).toBe('openai/gpt-5');
  expect(by.cf.agentCliModel).toBe('@cf/meta/llama-3');
  expect(by.nomodel.agentCliModel).toBeNull();
  expect(by.plain.agentCli).toBeNull();
  expect(by.plain.agentCliModel).toBeNull();

  // Undefined carries over unchanged, no duplicated lines.
  await savePersona({ ...base, name: 'cx' });
  const carried = await raw('cx');
  expect(carried.match(/^agentCli:/gm)).toHaveLength(1);
  expect(carried.match(/^agentCliModel:/gm)).toHaveLength(1);
  by = await list();
  expect(by.cx.agentCli).toBe('codex');
  expect(by.cx.agentCliModel).toBe('openai/gpt-5');

  // Explicit 'claude' removes both.
  await savePersona({ ...base, name: 'cx', agentCli: 'claude', agentCliModel: 'openai/gpt-5' });
  expect(await raw('cx')).not.toContain('agentCli');

  // Unknown on-disk value lists as null and never throws.
  await fsp.writeFile(path.join(globalDir, 'bad.md'), '---\nname: bad\nagentCli: gpt\nagentCliModel: "x y"\n---\nB.\n');
  await fsp.writeFile(path.join(globalDir, 'badmodel.md'), '---\nname: badmodel\nagentCli: codex \nagentCliModel: "has space"\n---\nB.\n');
  by = await list();
  expect(by.bad.agentCli).toBeNull();
  expect(by.bad.agentCliModel).toBeNull();
  expect(by.badmodel.agentCli).toBe('codex');
  expect(by.badmodel.agentCliModel).toBeNull();
  // An unknown on-disk value is not carried over either.
  await savePersona({ ...base, name: 'bad' });
  expect(await raw('bad')).not.toContain('agentCli');
});

test('listPersonas entries carry the loadout state', async () => {
  const globalDir = await mkTmp('sm-agent-library-loadout-');
  for (const [name, tools] of [['l-undecided', []], ['l-bare', ['none']], ['l-equipped', ['Read']], ['l-unbound', ['*']]]) {
    await savePersona({ ...base, name, description: 'd', body: 'B.', globalDir, tools });
  }
  const list = await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: identityValidatePath });
  const by = Object.fromEntries(list.map((p) => [p.name, p.loadout]));
  expect(by).toMatchObject({ 'l-undecided': 'undecided', 'l-bare': 'bare', 'l-equipped': 'equipped', 'l-unbound': 'unbound' });
});
