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

test('save keeps unmanaged frontmatter keys byte-for-byte', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'al-preserve-'));
  try {
    const file = path.join(dir, 'p.md');
    await fsp.writeFile(file, `---\nname: p\ndescription: old\nmodel: opus\n${UNMANAGED}\n---\nbody\n`);
    await savePersona({ name: 'p', description: 'new', model: 'inherit', body: 'body', globalDir: dir, validatePath: idPath, writeTextAtomic: write });
    const out = await fsp.readFile(file, 'utf8');
    expect(out).toContain(UNMANAGED);
    expect(out).toContain('description: new');
    expect(out).not.toContain('model:');
    expect(out.match(/^name:/gm)).toHaveLength(1);
    expect(out.match(/^description:/gm)).toHaveLength(1);
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
