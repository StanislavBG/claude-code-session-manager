// Guard: the voice id pattern lives in exactly one place in code —
// voiceLibrary.VOICE_ID_RE. Every other non-test .cjs under src/main must
// require it instead of declaring its own regex literal. Text inside string
// literals (tool descriptions, error messages) does not count.
const fs = require('node:fs');
const path = require('node:path');

const LIT = '/^[a-z0-9][a-z0-9_-]{0,63}$/';
const OWNER = path.join('lib', 'demo-video-kit', 'voiceLibrary.cjs');
const SRC_MAIN = path.resolve(__dirname, '..', '..', '..');

/** True when the char at idx of line sits inside a '…', "…" or `…` string on that line. */
function insideString(line, idx) {
  let q = null;
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (q) { if (c === q) q = null; } else if (c === '\'' || c === '"' || c === '`') q = c;
  }
  return q !== null;
}

/** -> lines (1-based) where the literal is used as code: `= LIT`, `.regex(LIT`, or `LIT.test(`. */
function codeUses(text) {
  const hits = [];
  text.split('\n').forEach((line, n) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    let from = 0;
    for (;;) {
      const idx = line.indexOf(LIT, from);
      if (idx < 0) break;
      from = idx + LIT.length;
      if (insideString(line, idx)) continue;
      const before = line.slice(0, idx);
      const after = line.slice(idx + LIT.length);
      if (/=\s*$/.test(before) || /\.regex\(\s*$/.test(before) || /^\s*\.test\(/.test(after)) hits.push(n + 1);
    }
  });
  return hits;
}

function cjsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') cjsFiles(p, out); }
    else if (e.name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

describe('voice id pattern has one copy in code', () => {
  it('only voiceLibrary.cjs declares the voice id regex literal', () => {
    const offenders = [];
    for (const f of cjsFiles(SRC_MAIN)) {
      if (path.relative(SRC_MAIN, f) === OWNER) continue;
      for (const n of codeUses(fs.readFileSync(f, 'utf8'))) offenders.push(`${path.relative(SRC_MAIN, f)}:${n}`);
    }
    expect(offenders).toEqual([]);
  });

  it('voiceLibrary.cjs still owns it', () => {
    expect(codeUses(fs.readFileSync(path.join(SRC_MAIN, OWNER), 'utf8')).length).toBe(1);
  });

  it('catches each copy the migration removed', () => {
    const removed = [
      'const VOICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;',
      'const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;',
      "    const jobVoiceId = (typeof job.voiceId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(job.voiceId)) ? job.voiceId : null;",
      "    voiceId: (typeof fm.voiceId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(fm.voiceId.trim())) ? fm.voiceId.trim() : null,",
      'const voiceLibraryId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);',
    ];
    for (const line of removed) expect(codeUses(line), line).toEqual([1]);
  });

  it('ignores the pattern inside string literals and comments', () => {
    const ok = [
      "    return 'voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/';",
      "    return { ok: false, error: 'voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/ when given' };",
      "      + '(a voice library id matching /^[a-z0-9][a-z0-9_-]{0,63}$/), so one character sounds the same. '",
      ' * voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/.test( in docs',
      '// x = /^[a-z0-9][a-z0-9_-]{0,63}$/',
    ];
    for (const line of ok) expect(codeUses(line), line).toEqual([]);
  });
});
