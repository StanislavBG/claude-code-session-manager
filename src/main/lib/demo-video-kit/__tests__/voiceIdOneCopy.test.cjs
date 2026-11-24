// Guard: the rule is that every non-test .cjs under src/main imports voiceLibrary's VOICE_ID_RE; this scan is only a backstop.
// It flags, outside voiceLibrary.cjs: the regex literal (any flags), a RegExp(...)
// built from a string holding the pattern body, a VOICE_ID_RE key or declaration
// bound to anything but voiceLibrary's export, and the [a-z\d]…{0,63} spelling.
// Text inside string literals (tool descriptions, error messages) and comments
// does not count.
const fs = require('node:fs');
const path = require('node:path');

const OWNER = path.join('lib', 'demo-video-kit', 'voiceLibrary.cjs');
const SRC_MAIN = path.resolve(__dirname, '..', '..', '..');

const BODY = '[a-z0-9][a-z0-9_-]{0,63}';
// The literal `/^BODY$/` with any trailing flags.
const LITERAL_RE = /\/\^\[a-z0-9\]\[a-z0-9_-\]\{0,63\}\$\/[a-z]*/g;
// RegExp( / new RegExp( whose first argument is a '…', "…" or `…` string.
const REGEXP_CTOR_RE = /\b(?:new\s+)?RegExp\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
// A declaration (`const VOICE_ID_RE =`, `exports.VOICE_ID_RE =`) or an object key (`{ VOICE_ID_RE: … }`).
const DECL_RE = /(?:\b(?:const|let|var)\s+|\bexports\.)VOICE_ID_RE\s*=(?!=)\s*/g;
const KEY_RE = /(?:^|[{,])\s*VOICE_ID_RE\s*:\s*/g;
// What a VOICE_ID_RE binding may be: voiceLibrary's export, or the bare imported name re-exported.
const OWNER_EXPORT_RE = /^(?:require\(\s*(['"`])[^'"`]*voiceLibrary(?:\.cjs)?\1\s*\)|\w*voiceLibrary\w*)\.VOICE_ID_RE\b|^VOICE_ID_RE\b(?!\s*[.(\[])/i;
// A destructuring import straight from voiceLibrary (allows `{ VOICE_ID_RE: re } = require(...)`).
const OWNER_DESTRUCTURE_RE = /^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\(\s*(['"`])[^'"`]*voiceLibrary(?:\.cjs)?\1\s*\)\s*;?\s*$/;

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

/** The line with any trailing `//` comment (outside strings) cut off. */
function codePart(line) {
  for (let i = line.indexOf('//'); i >= 0; i = line.indexOf('//', i + 1)) {
    if (line[i - 1] !== '\\' && !insideString(line, i)) return line.slice(0, i);
  }
  return line;
}

function* matches(re, line) {
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    yield m;
    if (m[0].length === 0) re.lastIndex++;
  }
}

/**
 * Pure scanner: -> [{ line, rule }] (1-based line) for every voice id copy in
 * `text`. rule ∈ literal | regexp-ctor | binding | digit-class.
 */
function scanVoiceIdCopies(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((raw, n) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    const line = codePart(raw);
    const add = (rule) => hits.push({ line: n + 1, rule });

    for (const m of matches(LITERAL_RE, line)) if (!insideString(line, m.index)) { add('literal'); break; }

    for (const m of matches(REGEXP_CTOR_RE, line)) {
      if (insideString(line, m.index)) continue;
      const src = m[2].replace(/\\\\/g, '\\');
      if (src.includes(BODY) || (src.includes('[a-z\\d') && src.includes('{0,63}'))) { add('regexp-ctor'); break; }
    }

    if (!OWNER_DESTRUCTURE_RE.test(line)) {
      for (const re of [DECL_RE, KEY_RE]) {
        for (const m of matches(re, line)) {
          const at = m.index + m[0].indexOf('VOICE_ID_RE');
          if (insideString(line, at)) continue;
          let rhs = line.slice(m.index + m[0].length).trim();
          for (let k = n + 1; !rhs && k < lines.length; k++) rhs = codePart(lines[k]).trim();
          if (!OWNER_EXPORT_RE.test(rhs)) { add('binding'); break; }
        }
      }
    }

    const d = line.indexOf('[a-z\\d');
    if (d >= 0 && !insideString(line, d) && line.indexOf('{0,63}', d) >= 0) add('digit-class');
  });
  return hits;
}

/** -> distinct 1-based lines with a voice id copy. */
function codeUses(text) {
  return [...new Set(scanVoiceIdCopies(text).map((h) => h.line))];
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
  it('only voiceLibrary.cjs declares the voice id regex', () => {
    const offenders = [];
    for (const f of cjsFiles(SRC_MAIN)) {
      if (path.relative(SRC_MAIN, f) === OWNER) continue;
      for (const h of scanVoiceIdCopies(fs.readFileSync(f, 'utf8'))) offenders.push(`${path.relative(SRC_MAIN, f)}:${h.line} (${h.rule})`);
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

  // Self-test: one known bad copy per rule (the scanner must flag it with that rule) …
  const BAD = [
    ['literal', 'const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;'],
    ['literal', 'if (/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(v)) ok();'],
    ['literal', 'check([/^[a-z0-9][a-z0-9_-]{0,63}$/gimsuy]);'],
    ['regexp-ctor', "const ID = new RegExp('^[a-z0-9][a-z0-9_-]{0,63}$');"],
    ['regexp-ctor', 'const ID = new RegExp("[a-z0-9][a-z0-9_-]{0,63}", \'i\');'],
    ['regexp-ctor', 'const ID = RegExp(`^[a-z0-9][a-z0-9_-]{0,63}$`);'],
    ['regexp-ctor', "const ID = new RegExp('^[a-z\\\\d][a-z\\\\d_-]{0,63}$');"],
    ['binding', 'const schemas = { VOICE_ID_RE: /^[a-z]+$/ };'],
    ['binding', 'module.exports = { foo, VOICE_ID_RE: makeRe() };'],
    ['binding', '  VOICE_ID_RE:\n    /^[a-z0-9-]+$/,'],
    ['binding', 'let VOICE_ID_RE = buildPattern();'],
    ['binding', 'exports.VOICE_ID_RE = /x/;'],
    ['digit-class', 'const ID = /^[a-z\\d][a-z\\d_-]{0,63}$/;'],
    ['digit-class', 'z.string().regex(/^[a-z\\d][a-z0-9_-]{0,63}$/)'],
  ];
  it.each(BAD)('flags a %s copy: %s', (rule, src) => {
    expect(scanVoiceIdCopies(src).map((h) => h.rule)).toContain(rule);
  });

  // … and good lines it must leave alone: the import (the rule), uses of it, and prose.
  const GOOD = [
    "const { VOICE_ID_RE } = require('./lib/demo-video-kit/voiceLibrary.cjs');",
    "const { VOICE_ID_RE: voiceRe } = require('../demo-video-kit/voiceLibrary.cjs');",
    "const VOICE_ID_RE = require('./voiceLibrary.cjs').VOICE_ID_RE;",
    'const VOICE_ID_RE = voiceLibrary.VOICE_ID_RE;',
    'module.exports = { registerAdminRoute, VOICE_ID_RE, TEXT_MAX };',
    'module.exports = { VOICE_ID_RE: VOICE_ID_RE };',
    'const re = ok ? VOICE_ID_RE : OTHER_RE;',
    'const voiceLibraryId = z.string().regex(VOICE_ID_RE);',
    'return `voiceId must match /${VOICE_ID_RE.source}/`;',
    "    return 'voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/i';",
    "    return { ok: false, error: 'voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/ when given' };",
    "      + '(a voice library id matching /^[a-z0-9][a-z0-9_-]{0,63}$/), so one character sounds the same. '",
    "  description: 'pass new RegExp(\"[a-z0-9][a-z0-9_-]{0,63}\") or [a-z\\\\d]{0,63}; VOICE_ID_RE: is the key',",
    ' * voiceId must match /^[a-z0-9][a-z0-9_-]{0,63}$/.test( in docs',
    '// x = /^[a-z0-9][a-z0-9_-]{0,63}$/',
    'const n = 1; // VOICE_ID_RE: /^[a-z\\d]{0,63}$/i',
    'const ENTRY_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;',
  ];
  it.each(GOOD)('does not flag: %s', (src) => {
    expect(scanVoiceIdCopies(src)).toEqual([]);
  });
});
