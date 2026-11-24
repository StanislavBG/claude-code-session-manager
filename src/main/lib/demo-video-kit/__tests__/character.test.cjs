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
