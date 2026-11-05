'use strict';
// vitest globals (describe/it/expect) — same convention as the other .cjs tests.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ipc = require('../promptSessionsIpc.cjs');

describe('promptSessionsIpc read tier', () => {
  let root;
  let roots;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'psipc-')));
    const dir = path.join(root, 'session-manager-operations', 'prompt-sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'active-index.json'), JSON.stringify({ sessions: { a: { id: 'a' } }, events: {} }));
    fs.writeFileSync(path.join(dir, 'done1.json'), JSON.stringify({ session: { id: 'done1' }, events: [] }));
    roots = { projectRoots: () => [root] };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the index, archive ids and an archive for a registered project', () => {
    expect(ipc.loadActiveIndex(root, roots).data.sessions.a.id).toBe('a');
    expect(ipc.listArchived(root, roots)).toEqual({ ok: true, ids: ['done1'] });
    expect(ipc.readArchived(root, 'done1', roots).data.session.id).toBe('done1');
    expect(ipc.readArchived(root, 'nope', roots).exists).toBe(false);
  });

  it('refuses a cwd that is not a registered project root', () => {
    const other = path.join(os.tmpdir(), 'not-a-project');
    expect(() => ipc.loadActiveIndex(other, roots)).toThrow(/not a registered project/);
    expect(() => ipc.listArchived(other, roots)).toThrow(/not a registered project/);
    expect(() => ipc.readArchived(other, 'x', roots)).toThrow(/not a registered project/);
    expect(() => ipc.readSessionTranscript(other, 's1', roots)).toThrow(/not a registered project/);
  });

  it('rejects path-traversal ids', () => {
    expect(() => ipc.readArchived(root, '../active-index', roots)).toThrow(/invalid epicId/);
    expect(() => ipc.readSessionTranscript(root, '../../etc/passwd', roots)).toThrow(/invalid sessionId/);
  });

  it('reads a session transcript through the injected resolver', () => {
    const f = path.join(root, 't.jsonl');
    fs.writeFileSync(f, 'line');
    expect(ipc.readSessionTranscript(root, 's1', { ...roots, resolvePath: () => f })).toEqual({ exists: true, text: 'line' });
    expect(ipc.readSessionTranscript(root, 's1', { ...roots, resolvePath: () => f + 'x' }).exists).toBe(false);
  });
});
