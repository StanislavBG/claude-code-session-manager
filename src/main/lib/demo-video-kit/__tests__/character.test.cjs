'use strict';
import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCharacter, speakWithCommand, buildCommandArgv, validateCharacterJson, characterDir } = require('../character.cjs');

const tmp = [];
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

function project(json, js = 'window.c={mount(){},pose(){},mouth(){}};') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-'));
  tmp.push(root);
  fs.mkdirSync(path.join(root, 'session-manager-operations'), { recursive: true });
  if (json !== undefined) {
    const dir = characterDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'character.json'), typeof json === 'string' ? json : JSON.stringify(json));
    if (js !== null) fs.writeFileSync(path.join(dir, 'character.js'), js);
  }
  return root;
}

const kokoro = { name: 'Bit', palette: ['#fff'], voice: { engine: 'kokoro', id: 'af_heart' } };
const cmd = { name: 'Bit', palette: ['#fff'], voice: { engine: 'command', command: ['say', '-o', '{out}', '{text}'] } };

test('valid kokoro and command characters read back', () => {
  expect(readCharacter(project(kokoro))).toMatchObject({ json: kokoro });
  expect(readCharacter(project(cmd)).json.voice.engine).toBe('command');
});

test('absent or invalid characters return null', () => {
  expect(readCharacter(project(undefined))).toBeNull();
  expect(readCharacter(project('{nope'))).toBeNull();
  expect(readCharacter(project({ ...kokoro, palette: [] }))).toBeNull();
  expect(readCharacter(project(kokoro, null))).toBeNull();
  expect(validateCharacterJson({ ...cmd, voice: { engine: 'command', command: ['say', '{text}'] } })).toMatch(/\{out\}/);
  expect(validateCharacterJson({ ...cmd, voice: { engine: 'command', command: ['say', '{out}'] } })).toMatch(/\{text\}/);
  expect(validateCharacterJson({ ...kokoro, voice: { engine: 'other' } })).toMatch(/engine/);
});

test('command argv is substituted per element, never shell-joined', () => {
  const text = 'hi; rm -rf / $(x) "q"';
  const argv = buildCommandArgv(cmd.voice, text, '/tmp/o.wav');
  expect(argv).toEqual(['say', '-o', '/tmp/o.wav', text]);
});

test('speakWithCommand runs without a shell', () => {
  const out = path.join(os.tmpdir(), `sm-char-out-${process.pid}.wav`);
  tmp.push(out);
  const voice = { engine: 'command', command: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[2], "RIFF" + "\\0".repeat(60) + process.argv[1])', '{text}', '{out}'] };
  const text = 'a; echo pwned $(id) `x`';
  const r = speakWithCommand(voice, text, out);
  expect(r.ok).toBe(true);
  expect(fs.readFileSync(out, 'utf8').slice(64)).toBe(text);
  expect(speakWithCommand(kokoro.voice, 'x', out).ok).toBe(false);
});

test('characterDir builds the ops-root path locally and refuses relative roots', () => {
  const root = path.join(os.tmpdir(), 'sm-char-root');
  const want = path.join(root, 'session-manager-operations', 'project-pages', 'videos', '_character');
  expect(characterDir(root)).toBe(want);
  expect(characterDir(path.join(root, 'session-manager-operations', 'scheduler'))).toBe(want);
  expect(() => characterDir('relative/dir')).toThrow(/absolute/);
  expect(() => characterDir('')).toThrow(/required/);
});

const { speakLines } = require('../character.cjs');
const CHAR_CJS = path.join(__dirname, '..', 'character.cjs');
// A fake voice: writes a RIFF WAV with the cwd as payload; fails loudly on text 'bad'.
const VOICE_SRC = [
  "const fs = require('fs');",
  "const [text, out] = process.argv.slice(2);",
  "if (text === 'bad') { process.stderr.write('voice exploded on: ' + text); process.exit(3); }",
  "if (text === 'silent') process.exit(0);",
  "fs.writeFileSync(out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60), Buffer.from(process.cwd())]));",
].join('\n');

function voiceProject(extra = {}) {
  const voice = { engine: 'command', command: [process.execPath, 'voice.cjs', '{text}', '{out}'] };
  const root = project({ ...cmd, voice, ...extra });
  fs.writeFileSync(path.join(root, 'voice.cjs'), VOICE_SRC);
  return { root, voice };
}

test('personality: optional strict object accepted; bad shapes return a reason', () => {
  expect(validateCharacterJson(kokoro)).toBeNull();
  expect(validateCharacterJson({ ...kokoro, personality: {} })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, personality: { who: 'A curious mole', speech: 'Short, warm', readingLevel: 'grade 5', neverSay: ['synergy', 'leverage'] } })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, personality: 'fun' })).toMatch(/personality/);
  expect(validateCharacterJson({ ...kokoro, personality: ['x'] })).toMatch(/personality/);
  expect(validateCharacterJson({ ...kokoro, personality: null })).toMatch(/personality/);
  expect(validateCharacterJson({ ...kokoro, personality: { mood: 'x' } })).toMatch(/mood/);
  expect(validateCharacterJson({ ...kokoro, personality: { who: '' } })).toMatch(/who/);
  expect(validateCharacterJson({ ...kokoro, personality: { who: 'x'.repeat(401) } })).toMatch(/who/);
  expect(validateCharacterJson({ ...kokoro, personality: { speech: 'x'.repeat(401) } })).toMatch(/speech/);
  expect(validateCharacterJson({ ...kokoro, personality: { readingLevel: 'x'.repeat(41) } })).toMatch(/readingLevel/);
  expect(validateCharacterJson({ ...kokoro, personality: { readingLevel: 5 } })).toMatch(/readingLevel/);
  expect(validateCharacterJson({ ...kokoro, personality: { neverSay: 'x' } })).toMatch(/neverSay/);
  expect(validateCharacterJson({ ...kokoro, personality: { neverSay: Array(41).fill('x') } })).toMatch(/neverSay/);
  expect(validateCharacterJson({ ...kokoro, personality: { neverSay: ['x'.repeat(41)] } })).toMatch(/neverSay/);
  expect(validateCharacterJson({ ...kokoro, personality: { neverSay: [''] } })).toMatch(/neverSay/);
  expect(validateCharacterJson({ ...kokoro, personality: { neverSay: Array(40).fill('x'.repeat(40)) } })).toBeNull();
});

test('speakWithCommand puts the command stderr in the error', () => {
  const { root, voice } = voiceProject();
  const r = speakWithCommand(voice, 'bad', path.join(root, 'o.wav'), { cwd: root });
  expect(r.ok).toBe(false);
  expect(r.status).toBe(3);
  expect(r.error).toMatch(/voice exploded on: bad/);
});

test('speakWithCommand: exit 0 without a WAV is a failure', () => {
  const { root, voice } = voiceProject();
  const out = path.join(root, 'o.wav');
  const r = speakWithCommand(voice, 'silent', out, { cwd: root });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/wrote no WAV/);
  expect(r.error).toContain(out);
  // a non-RIFF file is also no WAV
  const notWav = { engine: 'command', command: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[2], "x".repeat(100))', '{text}', '{out}'] };
  expect(speakWithCommand(notWav, 'hi', out).ok).toBe(false);
});

test('speakLines runs each line with cwd = project root (relative program resolves there)', () => {
  const { root } = voiceProject();
  const outs = [path.join(root, 'a.wav'), path.join(root, 'b.wav')];
  // pass a path inside the ops root: cwd must still be the project root
  const r = speakLines(path.join(root, 'session-manager-operations'), [{ text: 'one', out: outs[0] }, { text: 'two', out: outs[1] }]);
  expect(r).toEqual({ ok: true, outs });
  const buf = fs.readFileSync(outs[0]);
  expect(buf.subarray(0, 4).toString()).toBe('RIFF');
  expect(fs.realpathSync(buf.subarray(64).toString())).toBe(fs.realpathSync(root));
});

test('speakLines stops at the first failing line', () => {
  const { root } = voiceProject();
  const outs = ['a', 'b', 'c'].map((n) => path.join(root, `${n}.wav`));
  const r = speakLines(root, [{ text: 'one', out: outs[0] }, { text: 'bad', out: outs[1] }, { text: 'three', out: outs[2] }]);
  expect(r.ok).toBe(false);
  expect(r.line).toBe(1);
  expect(r.error).toMatch(/voice exploded/);
  expect(fs.existsSync(outs[0])).toBe(true);
  expect(fs.existsSync(outs[2])).toBe(false);
});

test('speakLines refuses a non-command voice or a missing character', () => {
  expect(speakLines(project(kokoro), [{ text: 'x', out: '/tmp/x.wav' }])).toMatchObject({ ok: false, error: expect.stringMatching(/command/) });
  expect(speakLines(project(undefined), [{ text: 'x', out: '/tmp/x.wav' }])).toMatchObject({ ok: false });
});

test('CLI: speak spec.json prints the JSON result; exit 1 with the error on stderr', () => {
  const { spawnSync } = require('node:child_process');
  const { root } = voiceProject();
  const spec = path.join(root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ projectRoot: root, lines: [{ text: 'one', out: path.join(root, 'a.wav') }] }));
  const ok = spawnSync(process.execPath, [CHAR_CJS, 'speak', spec], { encoding: 'utf8' });
  expect(ok.status).toBe(0);
  expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true });
  fs.writeFileSync(spec, JSON.stringify({ projectRoot: root, lines: [{ text: 'bad', out: path.join(root, 'b.wav') }] }));
  const bad = spawnSync(process.execPath, [CHAR_CJS, 'speak', spec], { encoding: 'utf8' });
  expect(bad.status).toBe(1);
  expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, line: 0 });
  expect(bad.stderr).toMatch(/voice exploded/);
});

const { validateVoice, inspectCharacter, MAX_JSON_BYTES, MAX_CAST_MEMBERS } = require('../character.cjs');
const castCmdVoice = { engine: 'command', command: ['say', '-o', '{out}', '{text}'] };

test('validateVoice: host reasons unchanged; cast reasons carry their path', () => {
  expect(validateCharacterJson({ ...kokoro, voice: undefined })).toBe('voice is required');
  expect(validateCharacterJson({ ...kokoro, voice: { engine: 'kokoro' } })).toBe('voice.id must be a non-empty string for engine kokoro');
  expect(validateCharacterJson({ ...cmd, voice: { engine: 'command', command: ['say', '{out}'] } })).toBe('voice.command must contain a {text} placeholder');
  expect(validateCharacterJson({ ...cmd, voice: { engine: 'command', command: ['say', '{text}'] } })).toBe('voice.command must contain an {out} placeholder');
  expect(validateCharacterJson({ ...kokoro, voice: { engine: 'x' } })).toBe("voice.engine must be 'kokoro' or 'command'");
  expect(validateVoice(kokoro.voice, 'voice')).toBeNull();
  expect(validateVoice(castCmdVoice, 'voice')).toBeNull();
  expect(validateVoice('x', 'cast[0].voice')).toBe('cast[0].voice must be an object');
  expect(validateVoice({ engine: 'command', command: ['say', '{text}'] }, 'cast[1].voice')).toBe('cast[1].voice.command must contain an {out} placeholder');
  expect(validateVoice({ engine: 'kokoro', id: '' }, 'cast[2].voice')).toBe('cast[2].voice.id must be a non-empty string for engine kokoro');
});

test('cast: absent, empty and valid casts are accepted', () => {
  expect(MAX_CAST_MEMBERS).toBe(8);
  expect(validateCharacterJson({ ...kokoro, cast: [] })).toBeNull();
  expect(validateCharacterJson({
    ...kokoro,
    cast: [
      { name: 'Gran Oak', voice: { engine: 'kokoro', id: 'bm_george' }, note: 'An old tree' },
      { name: 'Pip', voice: castCmdVoice },
      { name: 'Moss' },
    ],
  })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, cast: Array.from({ length: 8 }, (_, i) => ({ name: `M${i}` })) })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, cast: [{ name: 'x'.repeat(40), note: 'n'.repeat(400) }] })).toBeNull();
});

test('cast: every refusal names its reason', () => {
  const v = (cast) => validateCharacterJson({ ...kokoro, cast });
  expect(v({})).toBe('cast must be an array of at most 8 members');
  expect(v(null)).toBe('cast must be an array of at most 8 members');
  expect(v(Array.from({ length: 9 }, (_, i) => ({ name: `M${i}` })))).toBe('cast must be an array of at most 8 members');
  expect(v(['Pip'])).toBe('cast[0] must be an object');
  expect(v([{ name: 'Pip' }, null])).toBe('cast[1] must be an object');
  expect(v([[]])).toBe('cast[0] must be an object');
  expect(v([{ name: 'Pip', mood: 'x' }])).toBe('cast[0].mood is not a known key (name, voice, note)');
  expect(v([{}])).toBe('cast[0].name must be a 1-40 char string');
  expect(v([{ name: '   ' }])).toBe('cast[0].name must be a 1-40 char string');
  expect(v([{ name: 'x'.repeat(41) }])).toBe('cast[0].name must be a 1-40 char string');
  expect(v([{ name: 5 }])).toBe('cast[0].name must be a 1-40 char string');
  expect(v([{ name: ' bit ' }])).toBe('cast[0].name "bit" is the host\'s name');
  expect(v([{ name: 'Pip' }, { name: 'Moss' }, { name: ' PIP' }])).toBe('cast[2].name "PIP" duplicates cast[0].name');
  expect(v([{ name: 'Pip', voice: { engine: 'command', command: ['say', '{text}'] } }])).toBe('cast[0].voice.command must contain an {out} placeholder');
  expect(v([{ name: 'Pip', voice: null }])).toBe('cast[0].voice must be an object');
  expect(v([{ name: 'Pip', voice: { engine: 'nope' } }])).toBe("cast[0].voice.engine must be 'kokoro' or 'command'");
  expect(v([{ name: 'Pip', note: '' }])).toBe('cast[0].note must be a 1-400 char string');
  expect(v([{ name: 'Pip', note: 'n'.repeat(401) }])).toBe('cast[0].note must be a 1-400 char string');
  expect(v([{ name: 'Pip', note: 3 }])).toBe('cast[0].note must be a 1-400 char string');
  // host voice is checked before the cast
  expect(validateCharacterJson({ ...kokoro, voice: undefined, cast: 'x' })).toBe('voice is required');
});

test('inspectCharacter tells none-saved from saved-but-unusable, and why', () => {
  expect(MAX_JSON_BYTES).toBe(16 * 1024);
  const ok = inspectCharacter(project(kokoro));
  expect(ok).toMatchObject({ ok: true, json: kokoro });
  expect(typeof ok.js).toBe('string');

  const none = inspectCharacter(project(undefined));
  expect(none).toMatchObject({ ok: false, exists: false });
  expect(none.error).toMatch(/no character saved/);

  const big = inspectCharacter(project(JSON.stringify({ ...kokoro, pad: 'x'.repeat(MAX_JSON_BYTES) })));
  expect(big).toMatchObject({ ok: false, exists: true });
  expect(big.error).toMatch(new RegExp(String(MAX_JSON_BYTES)));

  const bad = inspectCharacter(project('{nope'));
  expect(bad).toMatchObject({ ok: false, exists: true });
  expect(bad.error).toMatch(/not valid JSON/);

  const invalid = inspectCharacter(project({ ...kokoro, cast: [{ name: 'Bit' }] }));
  expect(invalid).toEqual({ ok: false, exists: true, error: 'character.json invalid: cast[0].name "Bit" is the host\'s name' });

  const noJs = inspectCharacter(project(kokoro, null));
  expect(noJs).toMatchObject({ ok: false, exists: true });
  expect(noJs.error).toMatch(/character\.js is missing/);

  const emptyJs = inspectCharacter(project(kokoro, '  \n'));
  expect(emptyJs).toMatchObject({ ok: false, exists: true });
  expect(emptyJs.error).toMatch(/character\.js is empty/);

  // only character.js on disk: exists, but no character.json
  const jsOnly = project(undefined);
  fs.mkdirSync(characterDir(jsOnly), { recursive: true });
  fs.writeFileSync(path.join(characterDir(jsOnly), 'character.js'), 'x');
  const r = inspectCharacter(jsOnly);
  expect(r).toMatchObject({ ok: false, exists: true });
  expect(r.error).toMatch(/character\.json is missing/);

  const rel = inspectCharacter('relative/dir');
  expect(rel).toMatchObject({ ok: false, exists: false });
  expect(rel.error).toMatch(/absolute/);

  expect(readCharacter(project({ ...kokoro, cast: [{ name: 'Bit' }] }))).toBeNull();
  expect(readCharacter(project({ ...kokoro, cast: [{ name: 'Pip' }] })).json.cast).toEqual([{ name: 'Pip' }]);
});

// Per-speaker voices: a stub TTS at <root>/bin/tts that logs each call to calls.jsonl.
const TTS_STUB = [
  '#!/usr/bin/env node',
  "const fs = require('fs');",
  "const a = process.argv.slice(2);",
  "const get = (k) => a[a.indexOf(k) + 1];",
  "const speaker = get('--speaker'); const text = get('--text'); const out = get('--out');",
  "fs.appendFileSync('calls.jsonl', JSON.stringify({ speaker, text }) + '\\n');",
  "if (speaker === 'broken') { process.stderr.write('tts: no model for broken'); process.exit(1); }",
  "fs.writeFileSync(out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60), Buffer.from(text)]));",
].join('\n');
const ttsVoice = (key) => ({ engine: 'command', command: ['bin/tts', '--speaker', key, '--text', '{text}', '--out', '{out}'] });

function castProject(cast, voice = ttsVoice('host')) {
  const root = project({ name: 'Bit', palette: ['#fff'], voice, cast });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'tts'), TTS_STUB);
  fs.chmodSync(path.join(root, 'bin', 'tts'), 0o755);
  return root;
}
const calls = (root) => {
  const f = path.join(root, 'calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
function runCli(root, lines) {
  const { spawnSync } = require('node:child_process');
  const spec = path.join(root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ projectRoot: root, lines }));
  const r = spawnSync(process.execPath, [CHAR_CJS, 'speak', spec], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, result: JSON.parse(r.stdout) };
}
const CAST = [
  { name: 'Gran Oak', voice: ttsVoice('oak') },
  { name: 'Pip', voice: ttsVoice('pip') },
  { name: 'Moss' },
  { name: 'Fern', voice: { engine: 'kokoro', id: 'bf_emma' } },
  { name: 'Crack', voice: ttsVoice('broken') },
];

test.skipIf(process.platform === 'win32')('CLI: host and cast lines each run their own speaker voice, in order', () => {
  const root = castProject(CAST);
  const o = (n) => path.join(root, `${n}.wav`);
  const r = runCli(root, [
    { text: 'hello', out: o('a') },
    { text: 'creak', out: o('b'), speaker: ' gran oak ' },
    { text: 'squeak', out: o('c'), speaker: 'PIP' },
    { text: 'again', out: o('d'), speaker: 'bit' },
    { text: 'null', out: o('e'), speaker: null },
  ]);
  expect(r.status).toBe(0);
  expect(r.result).toEqual({ ok: true, outs: ['a', 'b', 'c', 'd', 'e'].map(o) });
  expect(calls(root)).toEqual([
    { speaker: 'host', text: 'hello' },
    { speaker: 'oak', text: 'creak' },
    { speaker: 'pip', text: 'squeak' },
    { speaker: 'host', text: 'again' },
    { speaker: 'host', text: 'null' },
  ]);
});

test.skipIf(process.platform === 'win32')('CLI: a failing cast voice exits 1 with its stderr and makes no further calls', () => {
  const root = castProject(CAST);
  const o = (n) => path.join(root, `${n}.wav`);
  const r = runCli(root, [
    { text: 'one', out: o('a') },
    { text: 'two', out: o('b'), speaker: 'Crack' },
    { text: 'three', out: o('c') },
  ]);
  expect(r.status).toBe(1);
  expect(r.result).toMatchObject({ ok: false, line: 1, speaker: 'Crack' });
  expect(r.stderr).toMatch(/tts: no model for broken/);
  expect(calls(root)).toEqual([{ speaker: 'host', text: 'one' }, { speaker: 'broken', text: 'two' }]);
});

test.skipIf(process.platform === 'win32')('CLI: unknown, voiceless and kokoro-voiced speakers run no command', () => {
  const root = castProject(CAST);
  const o = (n) => path.join(root, `${n}.wav`);
  const cases = [
    ['Nobody', /unknown speaker "Nobody" \(speakers: Bit, Gran Oak, Pip, Moss, Fern, Crack\)/],
    ['Moss', /"Moss" has no voice and never speaks lines/],
    ['fern', /"Fern" has a 'kokoro' voice, not 'command'/],
  ];
  for (const [speaker, re] of cases) {
    const r = runCli(root, [{ text: 'first', out: o('a') }, { text: 'x', out: o('b'), speaker }]);
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ ok: false, line: 1 });
    expect(r.stderr).toMatch(re);
  }
  const bad = runCli(root, [{ text: 'x', out: o('a'), speaker: '' }]);
  expect(bad.result).toMatchObject({ ok: false, line: 0, error: expect.stringMatching(/speaker\?/) });
  expect(calls(root)).toEqual([]);
});

test('speakLines: a missing character names inspectCharacter\'s reason', () => {
  const r = speakLines(project(undefined), [{ text: 'x', out: '/tmp/x.wav' }]);
  expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no valid saved character in .*: no character saved in/) });
});

// Batch voices: a {lines} command speaks a whole manifest in one call (spoken by speakLines, not per line).
const charMod = require('../character.cjs');
const batchVoice = { engine: 'command', command: ['bin/tts', '--lines', '{lines}'] };
const MIXES = 'command mixes {lines} with {text}/{out}; use {lines} alone or {text} with {out}';

test('validateVoice: a {lines} command without {text}/{out} is accepted for host and cast', () => {
  expect(validateVoice(batchVoice, 'voice')).toBeNull();
  expect(validateVoice({ engine: 'command', command: ['bin/tts', '--lines={lines}'] }, 'cast[0].voice')).toBeNull();
  expect(validateCharacterJson({ ...kokoro, voice: batchVoice })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, cast: [{ name: 'Pip', voice: batchVoice }] })).toBeNull();
});

test('validateVoice: a {lines} command mixed with {text} or {out} is refused with a named reason', () => {
  const withText = { engine: 'command', command: ['bin/tts', '{lines}', '{text}'] };
  const withOut = { engine: 'command', command: ['bin/tts', '{lines}', '--out={out}'] };
  const withBoth = { engine: 'command', command: ['bin/tts', '{lines}', '{text}', '{out}'] };
  expect(validateCharacterJson({ ...kokoro, voice: withText })).toBe(`voice.${MIXES}`);
  expect(validateCharacterJson({ ...kokoro, voice: withOut })).toBe(`voice.${MIXES}`);
  expect(validateCharacterJson({ ...kokoro, voice: withBoth })).toBe(`voice.${MIXES}`);
  expect(validateCharacterJson({ ...kokoro, cast: [{ name: 'Pip', voice: withBoth }] })).toBe(`cast[0].voice.${MIXES}`);
  expect(validateVoice(withText, 'cast[0].voice')).toBe(`cast[0].voice.${MIXES}`);
});

test('validateVoice: {lines} does not bypass the string[] and program-name checks', () => {
  expect(validateVoice({ engine: 'command', command: ['', '{lines}'] }, 'voice')).toBe('voice.command[0] must be a program name');
  expect(validateVoice({ engine: 'command', command: [] }, 'voice')).toBe('voice.command must be a non-empty string[]');
});

test('isBatchVoice is true only for a valid {lines} command voice', () => {
  expect(charMod.isBatchVoice(batchVoice)).toBe(true);
  expect(charMod.isBatchVoice(castCmdVoice)).toBe(false);
  expect(charMod.isBatchVoice(kokoro.voice)).toBe(false);
  expect(charMod.isBatchVoice({ engine: 'command', command: ['bin/tts', '{lines}', '{out}'] })).toBe(false);
  expect(charMod.isBatchVoice({ engine: 'command', command: ['', '{lines}'] })).toBe(false);
  expect(charMod.isBatchVoice(null)).toBe(false);
  expect(charMod.isBatchVoice(undefined)).toBe(false);
});

test('buildBatchArgv substitutes every {lines} per element and never joins argv', () => {
  const manifest = '/tmp/a b; rm -rf / $(id) `x` "q".json';
  const v = { engine: 'command', command: ['bin/tts', '--lines', '{lines}', '--also={lines}'] };
  const argv = charMod.buildBatchArgv(v, manifest);
  expect(argv).toEqual(['bin/tts', '--lines', manifest, `--also=${manifest}`]);
  expect(argv).toHaveLength(4);
  expect(v.command).toEqual(['bin/tts', '--lines', '{lines}', '--also={lines}']);
});

test('speakWithCommand refuses a batch voice and spawns nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-batch-'));
  tmp.push(root);
  const marker = path.join(root, 'ran');
  const v = { engine: 'command', command: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], "x")', marker, '{lines}'] };
  const r = speakWithCommand(v, 'hello', path.join(root, 'o.wav'));
  expect(r).toEqual({ ok: false, status: null, error: 'a {lines} voice is spoken by speakLines in one call per speaker, not per line' });
  expect(fs.existsSync(marker)).toBe(false);
});

// Batch speakers: a stub at <root>/bin/tts-batch reads the {lines} manifest and writes every out in one call.
const TTS_BATCH_STUB = [
  '#!/usr/bin/env node',
  "const fs = require('fs');",
  "const a = process.argv.slice(2);",
  "const get = (k) => a[a.indexOf(k) + 1];",
  "const speaker = get('--speaker');",
  "const manifest = JSON.parse(fs.readFileSync(get('--lines'), 'utf8'));",
  "fs.appendFileSync('calls.jsonl', JSON.stringify({ speaker, manifest }) + '\\n');",
  "if (speaker === 'broken') { process.stderr.write('tts: no model for broken'); process.exit(1); }",
  "const todo = speaker === 'lazy' ? manifest.slice(0, -1) : manifest;",
  "for (const l of todo) fs.writeFileSync(l.out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60), Buffer.from(l.text)]));",
].join('\n');
const ttsBatchVoice = (key) => ({ engine: 'command', command: ['bin/tts-batch', '--speaker', key, '--lines', '{lines}'] });

function batchProject(hostKey, cast = []) {
  const root = castProject(cast, ttsBatchVoice(hostKey));
  fs.writeFileSync(path.join(root, 'bin', 'tts-batch'), TTS_BATCH_STUB);
  fs.chmodSync(path.join(root, 'bin', 'tts-batch'), 0o755);
  return root;
}

test.skipIf(process.platform === 'win32')('speakLines: a batch host runs once with an absolute-out manifest; per-line cast calls run in order', () => {
  const root = batchProject('host', [{ name: 'Pip', voice: ttsVoice('pip') }]);
  const r = charMod.speakLines(root, [
    { text: 'hello', out: 'a.wav' },
    { text: 'squeak', out: path.join(root, 'b.wav'), speaker: 'Pip' },
    { text: 'again', out: 'c.WAV' },
    { text: 'more', out: path.join(root, 'd.wav'), speaker: 'pip' },
    { text: 'bye', out: 'e.wav', speaker: 'Bit' },
  ]);
  expect(r).toEqual({ ok: true, outs: ['a.wav', path.join(root, 'b.wav'), 'c.WAV', path.join(root, 'd.wav'), 'e.wav'] });
  expect(calls(root)).toEqual([
    { speaker: 'host', manifest: [
      { text: 'hello', out: path.join(root, 'a.wav') },
      { text: 'again', out: path.join(root, 'c.WAV') },
      { text: 'bye', out: path.join(root, 'e.wav') },
    ] },
    { speaker: 'pip', text: 'squeak' },
    { speaker: 'pip', text: 'more' },
  ]);
  expect(fs.readFileSync(path.join(root, 'c.WAV')).subarray(64).toString()).toBe('again');
});

test.skipIf(process.platform === 'win32')('speakLines: a batch voice exiting 1 fails with its stderr and runs no later call', () => {
  const root = batchProject('broken', [{ name: 'Pip', voice: ttsVoice('pip') }]);
  const r = charMod.speakLines(root, [
    { text: 'one', out: 'a.wav' },
    { text: 'two', out: 'b.wav', speaker: 'Pip' },
    { text: 'three', out: 'c.wav' },
  ]);
  expect(r).toMatchObject({ ok: false, line: 0, lines: [0, 2], speaker: 'Bit' });
  expect(r.error).toMatch(/exit 1/);
  expect(r.error).toMatch(/tts: no model for broken/);
  expect(calls(root).map((c) => c.speaker)).toEqual(['broken']);
});

test.skipIf(process.platform === 'win32')('speakLines: a batch voice skipping its last out fails even with a stale WAV there', () => {
  const root = batchProject('lazy');
  const stale = path.join(root, 'c.wav');
  fs.writeFileSync(stale, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]));
  const r = charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }, { text: 'two', out: 'b.wav' }, { text: 'three', out: 'c.wav' }]);
  expect(r).toMatchObject({ ok: false, line: 0, lines: [0, 1, 2], speaker: 'Bit' });
  expect(r.error).toMatch(/1 of 3 outs missing/);
  expect(r.error).toContain(stale);
  expect(fs.existsSync(stale)).toBe(false);
});

test('speakLines: batch outs must end in .wav and be distinct; nothing runs', () => {
  const root = batchProject('host', [{ name: 'Pip', voice: ttsVoice('pip') }]);
  const notWav = charMod.speakLines(root, [{ text: 'one', out: 'a.wav', speaker: 'Pip' }, { text: 'two', out: 'b.mp3' }]);
  expect(notWav).toMatchObject({ ok: false, line: 1, error: "line 1: a {lines} voice's out must end in .wav" });
  const dup = charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }, { text: 'two', out: path.join(root, 'a.wav') }]);
  expect(dup).toMatchObject({ ok: false, line: 1, error: `line 1: out ${path.join(root, 'a.wav')} repeats line 0's out` });
  expect(calls(root)).toEqual([]);
});

test('batchTimeoutMs: scales per line, caps at the ceiling and the job deadline, refuses too little time', () => {
  const { batchTimeoutMs, COMMAND_TIMEOUT_MS: per, BATCH_TIMEOUT_CEILING_MS, SPEAK_DEADLINE_MARGIN_MS, MIN_BATCH_TIMEOUT_MS } = charMod;
  expect(BATCH_TIMEOUT_CEILING_MS).toBe(180 * 60000);
  expect(SPEAK_DEADLINE_MARGIN_MS).toBe(45 * 60000);
  expect(MIN_BATCH_TIMEOUT_MS).toBe(60000);
  expect(batchTimeoutMs(1, { now: 0, env: {} })).toEqual({ ok: true, ms: per });
  expect(batchTimeoutMs(3, { now: 0, env: {} })).toEqual({ ok: true, ms: 3 * per });
  expect(batchTimeoutMs(40, { now: 0, env: {} })).toEqual({ ok: true, ms: BATCH_TIMEOUT_CEILING_MS });
  expect(batchTimeoutMs(40, { now: 0, env: { SM_SCHEDULER_JOB_DEADLINE_MS: 'soon' } })).toEqual({ ok: true, ms: BATCH_TIMEOUT_CEILING_MS });
  const now = 1_000_000;
  const deadline = String(now + SPEAK_DEADLINE_MARGIN_MS + 20 * 60000);
  expect(batchTimeoutMs(40, { now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: deadline } })).toEqual({ ok: true, ms: 20 * 60000 });
  const tight = String(now + SPEAK_DEADLINE_MARGIN_MS + 30000);
  const r = batchTimeoutMs(5, { now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: tight } });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/30s/);
  expect(r.error).toMatch(/5 lines/);
});

test.skipIf(process.platform === 'win32')('speakLines: too little time before the job deadline runs no batch call', () => {
  const root = batchProject('host');
  const prev = process.env.SM_SCHEDULER_JOB_DEADLINE_MS;
  process.env.SM_SCHEDULER_JOB_DEADLINE_MS = String(Date.now() + charMod.SPEAK_DEADLINE_MARGIN_MS + 1000);
  try {
    const r = charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }]);
    expect(r).toMatchObject({ ok: false, line: 0, lines: [0], speaker: 'Bit' });
  } finally {
    if (prev === undefined) delete process.env.SM_SCHEDULER_JOB_DEADLINE_MS; else process.env.SM_SCHEDULER_JOB_DEADLINE_MS = prev;
  }
  expect(calls(root)).toEqual([]);
});
