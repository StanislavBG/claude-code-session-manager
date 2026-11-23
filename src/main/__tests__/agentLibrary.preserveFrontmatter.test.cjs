import { test, expect } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { savePersona } = require('../agentLibrary.cjs');

const idPath = (p) => p;
const write = async (abs, text) => { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, text); };

const UNMANAGED = [
  'defaultEstimateMinutes: 20',
  'hooks:',
  '  PreToolUse:',
  '    - matcher: "Bash"',
  '      hooks:',
  '        - type: command',
  '          command: "echo hi"',
  'skills:',
  '  - alpha',
  '  - beta',
].join('\n');

// defaultEstimateMinutes is admitted by personaFrontmatterSchema (the scheduler
// reads it at dispatch, PRD 3773), so only hooks/skills are unknown here.
test('global save refuses a persona whose on-disk frontmatter carries unknown keys, leaving the file untouched', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'al-preserve-'));
  try {
    const file = path.join(dir, 'p.md');
    const original = `---\nname: p\ndescription: old\nmodel: opus\n${UNMANAGED}\n---\nbody\n`;
    await fsp.writeFile(file, original);
    await expect(savePersona({ name: 'p', description: 'new', model: 'opus', body: 'body', globalDir: dir, validatePath: idPath, writeTextAtomic: write }))
      .rejects.toThrow(/unknown frontmatter key\(s\): hooks, skills/);
    expect(await fsp.readFile(file, 'utf8')).toBe(original);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('overlay save keeps unmanaged keys', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'al-preserve-ov-'));
  try {
    const file = path.join(dir, '.claude', 'agents', 'p.md');
    // A tmp globalDir, so a routing bug can never write the real ~/.claude/agents/p.md.
    const globalDir = path.join(dir, 'global');
    await write(file, `---\nmodel: opus\n${UNMANAGED}\n---\n`);
    await savePersona({ name: 'p', projectCwd: dir, effort: 'high', globalDir, validatePath: idPath, writeTextAtomic: write,
      loadSessions: async () => ({ tabs: [{ cwd: dir }] }) });
    const out = await fsp.readFile(file, 'utf8');
    expect(out).toContain(UNMANAGED);
    expect(out).toContain('effort: high');
    expect(out).not.toContain('model:');
    await expect(fsp.access(path.join(globalDir, 'p.md'))).rejects.toThrow();
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('overlay save never writes agentCli/agentCliModel', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'al-preserve-ov-cli-'));
  try {
    const file = path.join(dir, '.claude', 'agents', 'p.md');
    const globalDir = path.join(dir, 'global');
    await savePersona({ name: 'p', projectCwd: dir, effort: 'high', agentCli: 'codex', agentCliModel: 'openai/gpt-5', globalDir, validatePath: idPath, writeTextAtomic: write,
      loadSessions: async () => ({ tabs: [{ cwd: dir }] }) });
    const out = await fsp.readFile(file, 'utf8');
    expect(out).toContain('effort: high');
    expect(out).not.toContain('agentCli');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
