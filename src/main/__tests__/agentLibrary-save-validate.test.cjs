// savePersona refuses frontmatter that fails validatePersonaFrontmatter —
// nothing reaches disk, and the thrown error names each failing key.
import { test, expect, afterEach } from 'vitest';
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { savePersona, listPersonas } = require('../agentLibrary.cjs');

const idPath = (p) => p;
const writes = [];
const write = async (abs, text) => {
  writes.push(abs);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, text);
};
const dirs = [];
async function mkTmp() {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'al-save-validate-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  writes.length = 0;
  await Promise.all(dirs.splice(0).map((d) => fsp.rm(d, { recursive: true, force: true })));
});

const base = { description: 'd', tools: ['Read'], body: 'You are p.', validatePath: idPath, writeTextAtomic: write };

test('a missing model is rejected, naming model, and no file is written', async () => {
  const globalDir = await mkTmp();
  await expect(savePersona({ ...base, name: 'p', globalDir })).rejects.toThrow(/model/);
  expect(writes).toEqual([]);
  await expect(fsp.access(path.join(globalDir, 'p.md'))).rejects.toThrow();
});

test('model "inherit" (serialized as no model line) is rejected too', async () => {
  const globalDir = await mkTmp();
  await expect(savePersona({ ...base, name: 'p', model: 'inherit', globalDir })).rejects.toThrow(/model is required/);
  expect(writes).toEqual([]);
});

test('an unknown key already on disk (preserved unmanaged line) is rejected by name; file left untouched', async () => {
  const globalDir = await mkTmp();
  const file = path.join(globalDir, 'p.md');
  const original = '---\nname: p\nmodel: opus\nhooks:\n  PreToolUse: []\nmy-key: 1\n---\nold body\n';
  await fsp.writeFile(file, original);
  const err = await savePersona({ ...base, name: 'p', model: 'opus', globalDir }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toMatch(/unknown frontmatter key/);
  expect(err.message).toContain('hooks');
  expect(err.message).toContain('my-key');
  expect(writes).toEqual([]);
  expect(await fsp.readFile(file, 'utf8')).toBe(original);
});

test('every failing key is named in one error (unknown key + missing model)', async () => {
  const globalDir = await mkTmp();
  await fsp.writeFile(path.join(globalDir, 'p.md'), '---\nname: p\nskills: a\n---\nb\n');
  const err = await savePersona({ ...base, name: 'p', globalDir }).catch((e) => e);
  expect(err.message).toContain('skills');
  expect(err.message).toMatch(/model/);
  expect(writes).toEqual([]);
});

test('a rename that fails validation does not remove the old file', async () => {
  const globalDir = await mkTmp();
  await fsp.writeFile(path.join(globalDir, 'old.md'), '---\nname: old\nmodel: opus\n---\nb\n');
  await expect(savePersona({ ...base, name: 'new', originalName: 'old', globalDir })).rejects.toThrow(/model/);
  await expect(fsp.access(path.join(globalDir, 'old.md'))).resolves.toBeUndefined();
  await expect(fsp.access(path.join(globalDir, 'new.md'))).rejects.toThrow();
});

test('a valid persona saves', async () => {
  const globalDir = await mkTmp();
  const res = await savePersona({ ...base, name: 'p', model: 'sonnet', effort: 'high', color: 'blue', tags: ['feature'], globalDir });
  expect(res.ok).toBe(true);
  const out = await fsp.readFile(path.join(globalDir, 'p.md'), 'utf8');
  expect(out).toContain('model: sonnet');
  expect(out).toContain('You are p.');
});

test('mcpServers is derived from mcp__ tools, unioned with the caller list (whole-server grants kept)', async () => {
  const globalDir = await mkTmp();
  await savePersona({ ...base, name: 'gear-a', model: 'sonnet', globalDir, tools: ['Read', 'mcp__blender__x', 'mcp__blender__y'], mcpServers: ['whole'] });
  const text = await fsp.readFile(path.join(globalDir, 'gear-a.md'), 'utf8');
  expect(text).toMatch(/^mcpServers: whole, blender$/m);
});

test('no mcp__ tools leaves the caller mcpServers untouched', async () => {
  const globalDir = await mkTmp();
  await savePersona({ ...base, name: 'gear-b', model: 'sonnet', globalDir, mcpServers: ['only'] });
  expect(await fsp.readFile(path.join(globalDir, 'gear-b.md'), 'utf8')).toMatch(/^mcpServers: only$/m);
});

test('a global save writes mcpServers, packs, environment and the loadout encoding', async () => {
  const globalDir = await mkTmp();
  await savePersona({ ...base, name: 'g', model: 'opus', globalDir, tools: [], loadout: 'bare', mcpServers: ['alpha'], packs: ['pk'], environment: 'sandboxed' });
  const text = await fsp.readFile(path.join(globalDir, 'g.md'), 'utf8');
  expect(text).toContain('tools: []');
  expect(text).toContain('mcpServers: alpha');
  expect(text).toContain('packs: pk');
  expect(text).toContain('environment: sandboxed');
  await savePersona({ ...base, name: 'g', model: 'opus', globalDir, loadout: 'unbound' });
  expect(await fsp.readFile(path.join(globalDir, 'g.md'), 'utf8')).toContain('tools: *');
  const list = await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: idPath });
  expect(list[0]).toMatchObject({ loadout: 'unbound', mcpServers: ['alpha'], packs: ['pk'], environment: 'sandboxed' });
});

test('a global save with explicit empty mcpServers/packs writes `[]`, which lists as none', async () => {
  const globalDir = await mkTmp();
  await savePersona({ ...base, name: 'e', model: 'opus', globalDir, mcpServers: ['alpha'], packs: ['pk'] });
  await savePersona({ ...base, name: 'e', model: 'opus', globalDir, mcpServers: [], packs: [] });
  const text = await fsp.readFile(path.join(globalDir, 'e.md'), 'utf8');
  expect(text).toContain('mcpServers: []');
  expect(text).toContain('packs: []');
  const list = await listPersonas({ globalDir, loadSessions: async () => ({ tabs: [] }), validatePath: idPath });
  expect(list[0]).toMatchObject({ mcpServers: [], packs: [], environment: null });
  // Omitted on the next save: the explicit empty is carried over, not dropped.
  await savePersona({ ...base, name: 'e', model: 'opus', globalDir });
  expect(await fsp.readFile(path.join(globalDir, 'e.md'), 'utf8')).toContain('mcpServers: []');
});
