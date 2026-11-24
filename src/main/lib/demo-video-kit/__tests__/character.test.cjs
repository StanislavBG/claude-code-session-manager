'use strict';
import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCharacter, speakWithCommand, buildCommandArgv, validateCharacterJson, characterDir } = require('../character.cjs');

// Every speak call goes through the voice lane: keep its tickets and usage log out of ~.
const LANE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-lane-'));
process.env.SM_VOICE_LANE_DIR = path.join(LANE_HOME, 'lane');
process.env.SM_VOICES_HOME = path.join(LANE_HOME, 'voices');
delete process.env.SM_SCHEDULER_JOB_DEADLINE_MS;

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

test('speakLines refuses a missing character; a kokoro voice is no longer refused as non-command', () => {
  const prev = process.env.KOKORO_MODEL_DIR;
  process.env.KOKORO_MODEL_DIR = path.join(os.tmpdir(), `sm-char-no-model-${process.pid}`);
  try {
    const r = speakLines(project(kokoro), [{ text: 'x', out: '/tmp/x.wav' }]);
    expect(r).toMatchObject({ ok: false, speaker: 'Bit', error: expect.stringMatching(/kokoro voice 'af_heart': Kokoro model file/) });
    expect(r.error).not.toMatch(/not 'command'/);
  } finally {
    if (prev === undefined) delete process.env.KOKORO_MODEL_DIR; else process.env.KOKORO_MODEL_DIR = prev;
  }
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
  expect(v([{ name: 'Pip', mood: 'x' }])).toBe('cast[0].mood is not a known key (name, voice, note, sfx)');
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

test.skipIf(process.platform === 'win32')('CLI: unknown and voiceless speakers run no command', () => {
  const root = castProject(CAST);
  const o = (n) => path.join(root, `${n}.wav`);
  const cases = [
    ['Nobody', /unknown speaker "Nobody" \(speakers: Bit, Gran Oak, Pip, Moss, Fern, Crack\)/],
    ['Moss', /"Moss" has no voice and never speaks lines/],
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
  const at = (leftMs, lines = 40) => batchTimeoutMs(lines, { now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: String(now + leftMs) } });
  // 65 min left: the reserve is a quarter (16.25 min), so 48.75 min to speak.
  expect(at(65 * 60000)).toEqual({ ok: true, ms: 65 * 60000 - 16.25 * 60000 });
  const r = at(50000, 5);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/37s/);
  expect(r.error).toMatch(/5 lines/);
});

test('speakReserveMs: a quarter of the time left, at most 45 min', () => {
  const { speakReserveMs, SPEAK_DEADLINE_MARGIN_MS } = charMod;
  expect(speakReserveMs(43 * 60000)).toBe(Math.floor(43 * 60000 / 4));
  expect(speakReserveMs(180 * 60000)).toBe(SPEAK_DEADLINE_MARGIN_MS);
  expect(speakReserveMs(10 * 60 * 60000)).toBe(SPEAK_DEADLINE_MARGIN_MS);
  expect(speakReserveMs(2 * 60000)).toBe(30000);
  expect(speakReserveMs(50000)).toBe(12500);
});

test('speak deadline reserve scales: 43 min, 180 min, 2 min, 50 s left and no deadline', () => {
  const { batchTimeoutMs, laneWaitMs, BATCH_TIMEOUT_CEILING_MS } = charMod;
  const now = 5_000_000;
  const env = (leftMs) => ({ SM_SCHEDULER_JOB_DEADLINE_MS: String(now + leftMs) });
  // 43 min left (a 45-minute-budget job a little in): ~32 min to wait and speak, not an instant failure.
  const m43 = 43 * 60000 - Math.floor(43 * 60000 / 4);
  expect(m43 / 60000).toBeCloseTo(32.25, 5);
  expect(laneWaitMs({ now, env: env(43 * 60000) })).toBe(m43);
  expect(batchTimeoutMs(40, { now, env: env(43 * 60000) })).toEqual({ ok: true, ms: m43 });
  // 180 min left: the full 45 min reserve, 135 min to speak.
  expect(laneWaitMs({ now, env: env(180 * 60000) })).toBe(135 * 60000);
  expect(batchTimeoutMs(40, { now, env: env(180 * 60000) })).toEqual({ ok: true, ms: 135 * 60000 });
  // 2 min left: 30 s reserve, 90 s to speak (above the 60 s floor).
  expect(laneWaitMs({ now, env: env(2 * 60000) })).toBe(90000);
  expect(batchTimeoutMs(40, { now, env: env(2 * 60000) })).toEqual({ ok: true, ms: 90000 });
  // 50 s left: 12.5 s reserve, 37.5 s to speak -> refused, naming the time left and the reserve.
  expect(laneWaitMs({ now, env: env(50000) })).toBe(37500);
  const r = batchTimeoutMs(3, { now, env: env(50000) });
  expect(r.ok).toBe(false);
  expect(r.error).toBe('only 37s left to speak for 3 lines (0.8 min left before the job deadline, 0.2 min kept in reserve); need at least 60s');
  expect(r.error).not.toMatch(/margin/);
  // No deadline: unchanged limits.
  expect(laneWaitMs({ now, env: {} })).toBe(6 * 60 * 60 * 1000);
  expect(batchTimeoutMs(40, { now, env: {} })).toEqual({ ok: true, ms: BATCH_TIMEOUT_CEILING_MS });
  expect(batchTimeoutMs(2, { now, env: {} })).toEqual({ ok: true, ms: 2 * charMod.COMMAND_TIMEOUT_MS });
});

test.skipIf(process.platform === 'win32')('speakLines: too little time before the job deadline runs no batch call', () => {
  const root = batchProject('host');
  const prev = process.env.SM_SCHEDULER_JOB_DEADLINE_MS;
  process.env.SM_SCHEDULER_JOB_DEADLINE_MS = String(Date.now() + 50000);
  try {
    const r = charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }]);
    expect(r).toMatchObject({ ok: false, line: 0, lines: [0], speaker: 'Bit' });
  } finally {
    if (prev === undefined) delete process.env.SM_SCHEDULER_JOB_DEADLINE_MS; else process.env.SM_SCHEDULER_JOB_DEADLINE_MS = prev;
  }
  expect(calls(root)).toEqual([]);
});

// Resumable speak CLI: slow stub voices (2 s per call) at <root>/bin/<name>, each call logged to calls.jsonl.
// When <root>/gate.<first text> exists (a FIFO the test made), the call blocks reading it after logging:
// the test's open(w) returning proves the call started, and closing it lets the call go on.
const { stopRun } = require('../resumableRun.cjs');
const SLOW_SRC = [
  '#!/usr/bin/env node',
  "const fs = require('fs');",
  "const a = process.argv.slice(2);",
  "const get = (k) => a[a.indexOf(k) + 1];",
  "const items = a.includes('--lines') ? JSON.parse(fs.readFileSync(get('--lines'), 'utf8')) : [{ text: get('--text'), out: get('--out') }];",
  "fs.appendFileSync('calls.jsonl', JSON.stringify({ texts: items.map((i) => i.text) }) + '\\n');",
  "if (fs.existsSync(`gate.${items[0].text}`)) fs.readFileSync(`gate.${items[0].text}`);",
  "if (items.some((i) => i.text === 'die')) process.kill(process.ppid, 'SIGKILL');",
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);",
  "for (const i of items) fs.writeFileSync(i.out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60), Buffer.from(i.text)]));",
].join('\n');
const slowVoices = {
  batch: { engine: 'command', command: ['bin/slow', '--lines', '{lines}'] },
  perLine: { engine: 'command', command: ['bin/slow', '--text', '{text}', '--out', '{out}'] },
};
const runDirs = [];
afterEach(() => { while (runDirs.length) stopRun(runDirs.pop()); });

function slowProject(voice) {
  const root = project({ name: 'Bit', palette: ['#fff'], voice });
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'slow'), SLOW_SRC);
  fs.chmodSync(path.join(root, 'bin', 'slow'), 0o755);
  const spec = path.join(root, 'spec.json');
  runDirs.push(`${spec}.run`);
  return { root, spec };
}
function writeSpec(root, spec, lines) {
  fs.writeFileSync(spec, JSON.stringify({ projectRoot: root, lines }));
}
function speak(spec, ...flags) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.BASH_DEFAULT_TIMEOUT_MS;
  const r = spawnSync(process.execPath, [CHAR_CJS, 'speak', spec, ...flags], { encoding: 'utf8', timeout: 60000, env });
  return { status: r.status, stderr: r.stderr, result: JSON.parse(r.stdout) };
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The runner exits just after writing its result, so the CLI can print before it is gone: poll a bounded while. */
async function runnerExited(pid, withinMs = 5000) {
  const until = Date.now() + withinMs;
  while (pidAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  return !pidAlive(pid);
}
function makeGate(root, text) {
  const gate = path.join(root, `gate.${text}`);
  const { spawnSync } = require('node:child_process');
  expect(spawnSync('mkfifo', [gate]).status).toBe(0);
  return gate;
}
/** Resolves with the gate's write handle once the gated voice call has opened it (the call is running). */
const gateHeld = (gate) => fs.promises.open(gate, 'w');

for (const [kind, lines] of [['batch', ['one', 'two']], ['perLine', ['one']]]) {
  test.skipIf(process.platform === 'win32')(`CLI speak (${kind}): pending with exit 75, then the same command attaches to the same run`, async () => {
    const { root, spec } = slowProject(slowVoices[kind]);
    const outs = lines.map((t) => path.join(root, `${t}.wav`));
    writeSpec(root, spec, lines.map((text, i) => ({ text, out: outs[i] })));
    const gate = makeGate(root, lines[0]); // the voice cannot finish before the test lets it
    const first = speak(spec, '--wait', '1');
    expect(first.status).toBe(75);
    expect(first.result).toMatchObject({ ok: false, pending: true, wavs: 0, lines: lines.length });
    expect(first.result.pid).toBeGreaterThan(0);
    expect(first.result.message).toBe(`still speaking (0/${lines.length} WAVs so far); run the same command again`);
    await (await gateHeld(gate)).close();
    const second = speak(spec, '--wait', '30');
    expect(second.status).toBe(0);
    expect(second.result).toEqual({ ok: true, outs });
    expect(calls(root)).toEqual([{ texts: lines }]);
    expect(await runnerExited(first.result.pid)).toBe(true);
  });
}

test.skipIf(process.platform === 'win32')('CLI speak: an edited spec mid-run stops the old run and starts a new one', async () => {
  const { root, spec } = slowProject(slowVoices.batch);
  writeSpec(root, spec, [{ text: 'old', out: 'old.wav' }]);
  const gate = makeGate(root, 'old'); // the old call holds until the old run is stopped
  const first = speak(spec, '--wait', '1');
  expect(first.status).toBe(75);
  const held = await gateHeld(gate); // the old voice call is running now
  writeSpec(root, spec, [{ text: 'new', out: 'new.wav' }]);
  const second = speak(spec, '--wait', '30');
  expect(second.status).toBe(0);
  expect(second.result).toEqual({ ok: true, outs: ['new.wav'] });
  await held.close();
  expect(pidAlive(first.result.pid)).toBe(false);
  expect(calls(root)).toEqual([{ texts: ['old'] }, { texts: ['new'] }]);
  expect(fs.existsSync(path.join(root, 'old.wav'))).toBe(false);
});

test.skipIf(process.platform === 'win32')('CLI speak: a killed runner exits 1 naming it with its log tail', () => {
  const { root, spec } = slowProject(slowVoices.perLine);
  writeSpec(root, spec, [{ text: 'die', out: 'a.wav' }]);
  const r = speak(spec, '--wait', '30');
  expect(r.status).toBe(1);
  expect(r.result.ok).toBe(false);
  expect(r.result.error).toMatch(/__speak-run/);
  expect(r.result.error).toMatch(/ended without a result; log tail/);
  expect(r.stderr).toMatch(/__speak-run/);
});

test.skipIf(process.platform === 'win32')('CLI speak: a finished spec is printed again without voice; a missing out reruns', () => {
  const { root, spec } = slowProject(slowVoices.batch);
  writeSpec(root, spec, [{ text: 'one', out: 'a.wav' }]);
  const first = speak(spec, '--wait', '30');
  expect(first.status).toBe(0);
  const again = speak(spec, '--wait', '30');
  expect(again.status).toBe(0);
  expect(again.result).toEqual(first.result);
  expect(calls(root)).toHaveLength(1);
  fs.rmSync(path.join(root, 'a.wav'));
  const rerun = speak(spec, '--wait', '30');
  expect(rerun.status).toBe(0);
  expect(calls(root)).toHaveLength(2);
});

test('CLI speak: a bad --wait or command is a usage error', () => {
  const { spawnSync } = require('node:child_process');
  const { root, spec } = slowProject(slowVoices.batch);
  writeSpec(root, spec, [{ text: 'one', out: 'a.wav' }]);
  for (const args of [['speak', spec, '--wait', '0'], ['speak', spec, '--wait', '841'], ['speak', spec, '--wait', '1.5'], ['speak', spec, '--wat', '5'], ['nope', spec]]) {
    const r = spawnSync(process.execPath, [CHAR_CJS, ...args], { encoding: 'utf8', timeout: 60000 });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, error: 'usage: node character.cjs speak spec.json [--wait seconds]' });
  }
  expect(calls(root)).toEqual([]);
});

const { isVoiceIdRef } = require('../character.cjs');

test('voiceId refs: host and cast accept exactly {voiceId}', () => {
  expect(isVoiceIdRef({ voiceId: 'af_heart' })).toBe(true);
  expect(isVoiceIdRef({ engine: 'kokoro', id: 'af_heart' })).toBe(false);
  expect(validateCharacterJson({ ...kokoro, voice: { voiceId: 'narrator-1' } })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, cast: [{ name: 'Pip', voice: { voiceId: 'pip_voice' } }] })).toBeNull();
  expect(validateCharacterJson({ ...kokoro, voice: { voiceId: 'x'.repeat(64) } })).toBeNull();
});

test('voiceId refs: extra keys and bad ids are refused by name', () => {
  expect(validateCharacterJson({ ...kokoro, voice: { voiceId: 'narrator', engine: 'kokoro' } }))
    .toBe('voice.engine is not allowed beside voiceId; a {voiceId} voice has exactly one key');
  expect(validateCharacterJson({ ...kokoro, cast: [{ name: 'Pip', voice: { voiceId: 'pip', id: 'af_heart' } }] }))
    .toBe('cast[0].voice.id is not allowed beside voiceId; a {voiceId} voice has exactly one key');
  expect(validateCharacterJson({ ...kokoro, voice: { voiceId: 'Bad Id' } })).toMatch(/^voice\.voiceId must match/);
  expect(validateCharacterJson({ ...kokoro, voice: { voiceId: '' } })).toMatch(/^voice\.voiceId must match/);
  expect(validateCharacterJson({ ...kokoro, voice: { voiceId: 'x'.repeat(65) } })).toMatch(/^voice\.voiceId must match/);
  expect(validateCharacterJson({ ...kokoro, cast: [{ name: 'Pip', voice: { voiceId: 7 } }] })).toMatch(/^cast\[0\]\.voice\.voiceId must match/);
});

// Library voices (PRD 3919): {voiceId} host/cast resolve through voiceLibrary; kokoro speaks via kokoroSay;
// spec.voice replaces the host voice. SM_VOICES_HOME, KOKORO_MODEL_DIR and SM_KOKORO_PYTHON point at temp fakes.
const FAKE_PY = [
  '#!/usr/bin/env node',
  "const fs = require('fs');",
  "const req = JSON.parse(fs.readFileSync(0, 'utf8'));",
  "fs.appendFileSync('kokoro-calls.jsonl', JSON.stringify(req.lines.map(({ text, out, voice, speed, lang }) => ({ text, out, voice, speed, lang }))) + '\\n');",
  "if (req.lines.some((l) => l.text === 'bad')) { console.log(JSON.stringify({ ok: false, error: 'kokoro exploded' })); process.exit(1); }",
  "for (const l of req.lines) fs.writeFileSync(l.out, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60), Buffer.from(l.text)]));",
  "console.log(JSON.stringify({ ok: true, seconds: req.lines.map(() => 1) }));",
].join('\n');
const LIB_ENV = ['SM_VOICES_HOME', 'KOKORO_MODEL_DIR', 'SM_KOKORO_PYTHON'];
let libEnvPrev = null;
afterEach(() => {
  if (!libEnvPrev) return;
  for (const k of LIB_ENV) { if (libEnvPrev[k] === undefined) delete process.env[k]; else process.env[k] = libEnvPrev[k]; }
  libEnvPrev = null;
});
function libEnv() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-lib-'));
  tmp.push(d);
  libEnvPrev = Object.fromEntries(LIB_ENV.map((k) => [k, process.env[k]]));
  const model = path.join(d, 'model');
  fs.mkdirSync(model);
  fs.writeFileSync(path.join(model, 'kokoro-v1.0.onnx'), 'x');
  fs.writeFileSync(path.join(model, 'voices-v1.0.bin'), 'not a zip');
  const py = path.join(d, 'fake-python');
  fs.writeFileSync(py, FAKE_PY);
  fs.chmodSync(py, 0o755);
  const env = { SM_VOICES_HOME: path.join(d, 'voices'), KOKORO_MODEL_DIR: model, SM_KOKORO_PYTHON: py };
  Object.assign(process.env, env);
  return env;
}
function libVoice(root, id, voice) {
  const dir = path.join(root, '.claude', 'voices');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ voice }));
}
const kokoroCalls = (root) => {
  const f = path.join(root, 'kokoro-calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test.skipIf(process.platform === 'win32')('speakLines: a {voiceId} host resolves to a library command voice', () => {
  libEnv();
  const root = castProject([], { voiceId: 'narrator' });
  libVoice(root, 'narrator', ttsVoice('lib-host'));
  const r = charMod.speakLines(root, [{ text: 'hello', out: 'a.wav' }, { text: 'bye', out: 'b.wav', speaker: 'Bit' }]);
  expect(r).toEqual({ ok: true, outs: ['a.wav', 'b.wav'] });
  expect(calls(root)).toEqual([{ speaker: 'lib-host', text: 'hello' }, { speaker: 'lib-host', text: 'bye' }]);
  expect(charMod.resolveSpeakerVoice(root, { voiceId: 'narrator' })).toMatchObject({ ok: true, voiceId: 'narrator', voice: ttsVoice('lib-host'), entry: { scope: 'project' } });
});

test.skipIf(process.platform === 'win32')('speakLines: an unknown {voiceId} fails the run naming speaker and voice, nothing speaks', () => {
  libEnv();
  const root = castProject([{ name: 'Pip', voice: { voiceId: 'no-such-voice' } }]);
  const r = charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }, { text: 'two', out: 'b.wav', speaker: 'Pip' }]);
  expect(r).toMatchObject({ ok: false, line: 1, speaker: 'Pip' });
  expect(r.error).toBe("line 1: \"Pip\" voice 'no-such-voice': unknown voice 'no-such-voice'");
  expect(calls(root)).toEqual([]);
});

test.skipIf(process.platform === 'win32')('speakLines: kokoro voices (inline and resolved) speak each speaker in ONE sayKokoro call', () => {
  libEnv();
  const root = castProject([
    { name: 'Fern', voice: { engine: 'kokoro', id: 'bf_emma', speed: 1.2, lang: 'en-gb' } },
    { name: 'Pip', voice: { voiceId: 'am_puck' } },
  ]);
  const r = charMod.speakLines(root, [
    { text: 'hi', out: 'a.wav' },
    { text: 'leaf', out: 'b.wav', speaker: 'Fern' },
    { text: 'puck', out: 'c.wav', speaker: 'pip' },
    { text: 'more leaf', out: 'd.wav', speaker: 'fern' },
  ]);
  expect(r).toEqual({ ok: true, outs: ['a.wav', 'b.wav', 'c.wav', 'd.wav'] });
  expect(calls(root)).toEqual([{ speaker: 'host', text: 'hi' }]);
  const o = (n) => path.join(root, `${n}.wav`);
  expect(kokoroCalls(root)).toEqual([
    [{ text: 'leaf', out: o('b'), voice: 'bf_emma', speed: 1.2, lang: 'en-gb' }, { text: 'more leaf', out: o('d'), voice: 'bf_emma', speed: 1.2, lang: 'en-gb' }],
    [{ text: 'puck', out: o('c'), voice: 'am_puck', speed: 1, lang: 'en-us' }],
  ]);
  expect(fs.readFileSync(o('d')).subarray(64).toString()).toBe('more leaf');
});

test.skipIf(process.platform === 'win32')('speakLines: a failing kokoro speaker stops the run with no later call', () => {
  libEnv();
  const root = castProject([{ name: 'Fern', voice: { engine: 'kokoro', id: 'bf_emma' } }]);
  const r = charMod.speakLines(root, [{ text: 'bad', out: 'a.wav', speaker: 'Fern' }, { text: 'after', out: 'b.wav' }]);
  expect(r).toMatchObject({ ok: false, line: 0, lines: [0], speaker: 'Fern' });
  expect(r.error).toMatch(/^"Fern" kokoro voice 'bf_emma': Kokoro failed \(exit 1\): kokoro exploded/);
  expect(calls(root)).toEqual([]);
  const notWav = charMod.speakLines(root, [{ text: 'x', out: 'a.mp3', speaker: 'Fern' }]);
  expect(notWav).toMatchObject({ ok: false, line: 0, error: "line 0: a kokoro voice's out must end in .wav" });
});

test.skipIf(process.platform === 'win32')('CLI: spec.voice replaces the host voice for that run only; cast keeps its own voice', () => {
  libEnv();
  const root = castProject([{ name: 'Pip', voice: ttsVoice('pip') }]);
  const spec = path.join(root, 'spec.json');
  runDirs.push(`${spec}.run`);
  fs.writeFileSync(spec, JSON.stringify({ projectRoot: root, voice: 'af_heart', lines: [{ text: 'hi', out: 'a.wav' }, { text: 'sq', out: 'b.wav', speaker: 'Pip' }] }));
  const r = speak(spec, '--wait', '30');
  expect(r.status).toBe(0);
  expect(r.result).toEqual({ ok: true, outs: ['a.wav', 'b.wav'] });
  expect(kokoroCalls(root)).toEqual([[{ text: 'hi', out: path.join(root, 'a.wav'), voice: 'af_heart', speed: 1, lang: 'en-us' }]]);
  expect(calls(root)).toEqual([{ speaker: 'pip', text: 'sq' }]);
  // the saved character is untouched: without spec.voice the host speaks its own voice
  expect(charMod.speakLines(root, [{ text: 'own', out: 'c.wav' }])).toEqual({ ok: true, outs: ['c.wav'] });
  expect(calls(root)).toEqual([{ speaker: 'pip', text: 'sq' }, { speaker: 'host', text: 'own' }]);
  // an inline spec.voice object works too
  expect(charMod.speakLines(root, [{ text: 'inl', out: 'd.wav' }], { voice: ttsVoice('inline') })).toEqual({ ok: true, outs: ['d.wav'] });
  expect(calls(root).at(-1)).toEqual({ speaker: 'inline', text: 'inl' });
});

test.skipIf(process.platform === 'win32')('CLI: spec.voice with no saved character speaks every line; a named speaker is refused', () => {
  libEnv();
  const root = project(undefined);
  const spec = path.join(root, 'spec.json');
  runDirs.push(`${spec}.run`);
  fs.writeFileSync(spec, JSON.stringify({ projectRoot: root, voice: { engine: 'kokoro', id: 'af_bella' }, lines: [{ text: 'one', out: 'a.wav' }, { text: 'two', out: 'b.wav', speaker: null }] }));
  const ok = speak(spec, '--wait', '30');
  expect(ok.status).toBe(0);
  expect(ok.result).toEqual({ ok: true, outs: ['a.wav', 'b.wav'] });
  expect(kokoroCalls(root)).toHaveLength(1);
  expect(kokoroCalls(root)[0].map((l) => l.voice)).toEqual(['af_bella', 'af_bella']);
  const cast = charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }, { text: 'x', out: 'c.wav', speaker: 'Pip' }], { voice: 'af_bella' });
  expect(cast).toMatchObject({ ok: false, line: 1, error: expect.stringMatching(/speaker "Pip" is refused: no character is saved/) });
  expect(charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }], { voice: 'no-such' })).toMatchObject({ ok: false, error: "line 0: \"spec.voice\" voice 'no-such': unknown voice 'no-such'" });
  expect(charMod.speakLines(root, [{ text: 'one', out: 'a.wav' }], { voice: { engine: 'nope' } })).toMatchObject({ ok: false, error: expect.stringMatching(/^spec\.voice\.engine/) });
  expect(kokoroCalls(root)).toHaveLength(1);
});

// Voice lane: a heavy fake command voice sleeps 400 ms per line, writes a real
// 0.5 s WAV (16 kHz mono 16-bit) and logs its start/end to a shared file.
// When `<log>.gate.<text>` exists (a FIFO the test made), the call blocks reading it
// until the test closes its write end: the test then knows the call holds the lane
// (its open() returned) and decides when it may leave, with no timer.
const lane = require('../voiceLane.cjs');
const HEAVY_SRC = [
  "const fs = require('fs');",
  "const [log, text, out] = process.argv.slice(2);",
  "if (fs.existsSync(`${log}.gate.${text}`)) fs.readFileSync(`${log}.gate.${text}`);",
  "const start = Date.now();",
  "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);",
  "if (text === 'bad') { process.stderr.write('heavy voice exploded'); process.exit(4); }",
  "const data = Buffer.alloc(16000);",
  "const h = Buffer.alloc(44);",
  "h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');",
  "h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);",
  "h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);",
  "h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);",
  "fs.writeFileSync(out, Buffer.concat([h, data]));",
  "fs.appendFileSync(log, JSON.stringify({ text, start, end: Date.now() }) + '\\n');",
].join('\n');
function heavyProject(logFile, name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-heavy-'));
  tmp.push(base);
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'session-manager-operations'), { recursive: true });
  fs.writeFileSync(path.join(root, 'heavy.cjs'), HEAVY_SRC);
  const voice = { engine: 'command', command: [process.execPath, 'heavy.cjs', logFile, '{text}', '{out}'] };
  const dir = characterDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify({ name: 'Bit', palette: ['#fff'], voice }));
  fs.writeFileSync(path.join(dir, 'character.js'), 'window.c={mount(){},pose(){},mouth(){}};');
  const spec = path.join(root, 'spec.json');
  runDirs.push(`${spec}.run`);
  return { root, spec };
}
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('wavSeconds reads byteRate and data size; 0 when unparseable', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-wav-'));
  tmp.push(d);
  const data = Buffer.alloc(48000);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt32LE(32000, 28);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(d, 'ok.wav'), Buffer.concat([h, data]));
  fs.writeFileSync(path.join(d, 'fake.wav'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(60)]));
  expect(charMod.wavSeconds(path.join(d, 'ok.wav'))).toBe(1.5);
  expect(charMod.wavSeconds(path.join(d, 'fake.wav'))).toBe(0);
  expect(charMod.wavSeconds(path.join(d, 'missing.wav'))).toBe(0);
});

test('laneWaitMs: time left minus the speak reserve when a deadline is set, else 6 h', () => {
  const now = 1_000_000_000;
  expect(charMod.laneWaitMs({ now, env: {} })).toBe(6 * 60 * 60 * 1000);
  expect(charMod.laneWaitMs({ now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: String(now + 60 * 60 * 1000) } })).toBe(45 * 60 * 1000);
  expect(charMod.laneWaitMs({ now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: '' } })).toBe(6 * 60 * 60 * 1000);
});

test('deadlineContext: names the minutes left and the reserve when a deadline is set, else nothing', () => {
  const now = 1_000_000_000;
  const env = (leftMs) => ({ SM_SCHEDULER_JOB_DEADLINE_MS: String(now + leftMs) });
  // 50 s left: the lane may wait 37.5 s, 12.5 s kept back — the same numbers the batch error names
  expect(charMod.deadlineContext({ now, env: env(50000) })).toBe(' (0.8 min left before the job deadline, 0.2 min kept in reserve)');
  expect(charMod.batchTimeoutMs(3, { now, env: env(50000) }).error).toContain(charMod.deadlineContext({ now, env: env(50000) }));
  // deadline already passed: the wait budget is gone before the wait starts
  expect(charMod.laneWaitMs({ now, env: env(-1000) })).toBeLessThanOrEqual(0);
  expect(charMod.deadlineContext({ now, env: env(-1000) })).toBe(' (0 min left before the job deadline, 0 min kept in reserve)');
  // long job: the full 45 min reserve
  expect(charMod.deadlineContext({ now, env: env(180 * 60000) })).toBe(' (180 min left before the job deadline, 45 min kept in reserve)');
  // no deadline (unset, empty, not a number): no suffix, the lane error is unchanged
  expect(charMod.deadlineContext({ now, env: {} })).toBe('');
  expect(charMod.deadlineContext({ now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: '' } })).toBe('');
  expect(charMod.deadlineContext({ now, env: { SM_SCHEDULER_JOB_DEADLINE_MS: 'soon' } })).toBe('');
});

test.skipIf(process.platform === 'win32')('voice lane: a failing voice still leaves the lane and logs ok:false', () => {
  const log = path.join(LANE_HOME, `fail-${Date.now()}.jsonl`);
  const { root } = heavyProject(log, 'failproj');
  const r = charMod.speakLines(root, [{ text: 'bad', out: 'a.wav' }], { kind: 'tiktok' });
  expect(r).toMatchObject({ ok: false, line: 0, speaker: 'Bit' });
  expect(r.error).toMatch(/heavy voice exploded/);
  expect(lane.laneSnapshot().heavy).toEqual([]);
  const [u] = lane.readUsage({ projectRoot: root });
  expect(u).toMatchObject({ voiceId: 'inline:command', projectRoot: root, lane: 'heavy', kind: 'tiktok', ok: false, audioSeconds: 0 });
  expect(u.wallMs).toBeGreaterThanOrEqual(400);
});

test.skipIf(process.platform === 'win32')('voice lane: a wait past the job deadline fails naming the lane position and leaves the lane', () => {
  const log = path.join(LANE_HOME, `late-${Date.now()}.jsonl`);
  const { root } = heavyProject(log, 'lateproj');
  const holder = lane.enterLane({ lane: 'heavy', voiceId: 'other', label: 'video other', projectRoot: '/x', kind: 'video' });
  const prev = process.env.SM_SCHEDULER_JOB_DEADLINE_MS;
  process.env.SM_SCHEDULER_JOB_DEADLINE_MS = String(Date.now() - 1000);
  try {
    const r = charMod.speakLines(root, [{ text: 'hi', out: 'a.wav' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out after \d+ ms at position 1 of 2/);
    expect(r.error).toMatch(/ \(0 min left before the job deadline, 0 min kept in reserve\)$/);
    expect(readJsonl(log)).toEqual([]);
  } finally {
    if (prev === undefined) delete process.env.SM_SCHEDULER_JOB_DEADLINE_MS; else process.env.SM_SCHEDULER_JOB_DEADLINE_MS = prev;
    lane.leaveLane(holder, { record: false });
  }
  expect(lane.laneSnapshot().heavy).toEqual([]);
});

test.skipIf(process.platform === 'win32')('voice lane: two concurrent speak CLI runs with a heavy voice never overlap; the second waits at position 1', async () => {
  const { spawn, spawnSync } = require('node:child_process');
  const log = path.join(LANE_HOME, `overlap-${Date.now()}.jsonl`);
  const a = heavyProject(log, 'alpha');
  const b = heavyProject(log, 'beta');
  const aTexts = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'];
  fs.writeFileSync(a.spec, JSON.stringify({ projectRoot: a.root, lines: aTexts.map((t) => ({ text: t, out: `${t}.wav` })) }));
  fs.writeFileSync(b.spec, JSON.stringify({ projectRoot: b.root, kind: 'marketing', lines: [{ text: 'b1', out: 'b1.wav' }, { text: 'b2', out: 'b2.wav' }] }));
  const env = { ...process.env };
  delete env.BASH_DEFAULT_TIMEOUT_MS;
  // alpha's first call blocks on this FIFO, holding the heavy lane until the test closes it
  const gate = `${log}.gate.a1`;
  expect(spawnSync('mkfifo', [gate]).status).toBe(0);
  const aChild = spawn(process.execPath, [CHAR_CJS, 'speak', a.spec, '--wait', '30'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let aOut = '';
  let aErr = '';
  aChild.stdout.on('data', (c) => { aOut += c; });
  aChild.stderr.on('data', (c) => { aErr += c; });
  const aDone = new Promise((resolve) => aChild.on('close', (code) => resolve(code)));
  let gateFd = null;
  let aSettled = false;
  // open(w) on the FIFO returns once alpha's a1 call opened it to read: alpha holds the lane
  const gateOpen = fs.promises.open(gate, 'w');
  try {
    gateFd = await Promise.race([
      gateOpen,
      aDone.then((code) => { throw new Error(`alpha exited ${code} before its first call: ${aOut}${aErr}`); }),
    ]);
    expect(lane.laneSnapshot().heavy).toHaveLength(1);
    // alpha holds the lane until the gate closes, so beta can only ever wait behind it.
    // Each call waits 1 s for beta's runner; repeat (same command attaches) until it reports its lane.
    let first = null;
    for (let i = 0; i < 30 && !(first && first.lane); i++) {
      const r = spawnSync(process.execPath, [CHAR_CJS, 'speak', b.spec, '--wait', '1'], { encoding: 'utf8', timeout: 30000, env });
      expect(r.status).toBe(75);
      first = JSON.parse(r.stdout);
    }
    const pending = first;
    expect(pending.lane).toMatchObject({ lane: 'heavy', position: 1, total: 2 });
    expect(pending.message).toMatch(new RegExp(`voice lane: waiting, position 1 of 2 \\(ahead: video alpha inline:command\\)`));
    await gateFd.close(); // alpha's a1 call reads EOF and finishes
    const second = spawnSync(process.execPath, [CHAR_CJS, 'speak', b.spec, '--wait', '30'], { encoding: 'utf8', timeout: 30000, env });
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ ok: true, outs: ['b1.wav', 'b2.wav'] });
    expect(await aDone).toBe(0);
    aSettled = true;
  } finally {
    if (gateFd) await gateFd.close(); // no-op when already closed
    // a still-blocked open(w) (alpha never reached its call) returns once a reader opens the FIFO
    try { fs.closeSync(fs.openSync(gate, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)); } catch { /* gone */ }
    if (!gateFd) await gateOpen.then((fd) => fd.close(), () => {});
    // on a failure above, stop alpha's CLI; either way its exit is awaited before the test ends
    if (!aSettled) aChild.kill('SIGTERM');
    await aDone;
  }
  expect(JSON.parse(aOut)).toMatchObject({ ok: true });
  // no two synthesis calls overlapped, machine-wide
  const calls = readJsonl(log).sort((x, y) => x.start - y.start);
  expect(calls).toHaveLength(10);
  for (let i = 1; i < calls.length; i++) expect(calls[i].start).toBeGreaterThanOrEqual(calls[i - 1].end);
  // beta's first lane line is position 1, behind alpha
  const runLog = fs.readFileSync(path.join(`${b.spec}.run`, 'run.log'), 'utf8');
  const laneLines = runLog.split('\n').filter((l) => l.startsWith('voice lane:'));
  expect(laneLines[0]).toBe('voice lane: waiting, position 1 of 2 (ahead: video alpha inline:command)');
  // usage: one line per call with kind, voice id, audio seconds and wall time
  const ua = lane.readUsage({ projectRoot: a.root, limit: 100 });
  const ub = lane.readUsage({ projectRoot: b.root, limit: 100 });
  expect(ua).toHaveLength(8);
  expect(ub).toHaveLength(2);
  for (const u of ua) expect(u).toMatchObject({ voiceId: 'inline:command', kind: 'video', lane: 'heavy', ok: true, audioSeconds: 0.5 });
  for (const u of ub) expect(u).toMatchObject({ voiceId: 'inline:command', kind: 'marketing', lane: 'heavy', ok: true, audioSeconds: 0.5 });
  for (const u of [...ua, ...ub]) expect(u.wallMs).toBeGreaterThanOrEqual(400);
  expect(lane.laneSnapshot().heavy).toEqual([]);
}, 60000);
