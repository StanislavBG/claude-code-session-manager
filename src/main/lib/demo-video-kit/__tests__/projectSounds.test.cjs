/**
 * projectSounds.test.cjs — a persona's own sound effects and music beds: the `sounds` block,
 * a cast member's `sfx`, the WAV header/size checks and where each WAV lives.
 * Run: timeout 120 npx vitest run src/main/lib/demo-video-kit/__tests__/projectSounds.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const os = require('node:os');
const path = require('node:path');
const ps = require('../projectSounds.cjs');
const { characterDir } = require('../character.cjs');

const {
  validateSounds, validateMemberSfx, fileBackedSoundNames, findProjectSound,
  wavFormatError, checkSoundWav, soundsDir, soundFile,
} = ps;

/** A WAV header plus `frames` zero sample frames. */
function wav({ tag = 1, ch = 1, sr = 44100, bits = 16, frames = 100, riff = 'RIFF', omitFmt = false, omitData = false } = {}) {
  const parts = [];
  if (!omitFmt) {
    const fmt = Buffer.alloc(8 + 16);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(tag, 8);
    fmt.writeUInt16LE(ch, 10);
    fmt.writeUInt32LE(sr, 12);
    fmt.writeUInt32LE(sr * ch * (bits / 8), 16);
    fmt.writeUInt16LE(ch * (bits / 8), 20);
    fmt.writeUInt16LE(bits, 22);
    parts.push(fmt);
  }
  if (!omitData) {
    const size = frames * ch * Math.max(1, bits / 8);
    const data = Buffer.alloc(8 + size);
    data.write('data', 0, 'ascii');
    data.writeUInt32LE(size, 4);
    parts.push(data);
  }
  const head = Buffer.alloc(12);
  head.write(riff, 0, 'ascii');
  const body = Buffer.concat(parts);
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WAVE', 8, 'ascii');
  return Buffer.concat([head, body]);
}

const VALID = {
  sfx: [{ name: 'bark', note: 'two short barks' }],
  beds: [
    { name: 'calm-keys', note: 'slow warm keys' },
    { name: 'bright-loop', command: ['bin/bed', '{name}', '{lengthS}', '{seed}', '{out}'] },
  ],
};

test('constants match the contract', () => {
  expect(ps.SOUND_NAME_RE.source).toBe('^[a-z][a-z0-9-]{0,31}$');
  expect([ps.MAX_PROJECT_SFX, ps.MAX_PROJECT_BEDS, ps.MAX_MEMBER_SFX, ps.SOUND_NOTE_MAX]).toEqual([16, 8, 8, 200]);
  expect([ps.MAX_SFX_WAV_BYTES, ps.MAX_BED_WAV_BYTES, ps.MAX_SOUNDS_TOTAL_BYTES]).toEqual([1048576, 12582912, 33554432]);
});

test('loading the module pulls in no sibling kit file', () => {
  const dir = path.join(__dirname, '..');
  const modPath = require.resolve('../projectSounds.cjs');
  const siblings = ['sound.cjs', 'character.cjs'].map((f) => path.join(dir, f));
  const saved = siblings.map((p) => [p, require.cache[p]]);
  const savedSelf = require.cache[modPath];
  try {
    for (const p of [...siblings, modPath]) delete require.cache[p];
    require('../projectSounds.cjs');
    for (const p of siblings) expect(require.cache[p], p).toBeUndefined();
  } finally {
    for (const [p, m] of saved) if (m) require.cache[p] = m;
    if (savedSelf) require.cache[modPath] = savedSelf;
  }
});

test('validateSounds accepts a valid block, an empty block and empty arrays', () => {
  expect(validateSounds(VALID)).toBeNull();
  expect(validateSounds({})).toBeNull();
  expect(validateSounds({ sfx: [], beds: [] })).toBeNull();
  expect(validateSounds({ beds: [{ name: 'b', command: ['x', '{lengthS}', '{out}'] }] })).toBeNull();
});

test.each([
  ['a non-object', null, 'sounds must be an object with optional sfx and beds arrays'],
  ['an array', [], 'sounds must be an object with optional sfx and beds arrays'],
  ['an unknown key', { music: [] }, 'sounds.music is not a known key (sfx, beds)'],
  ['sfx not an array', { sfx: 'bark' }, 'sounds.sfx must be an array of at most 16 sound effects'],
  ['too many sfx', { sfx: Array.from({ length: 17 }, (_, i) => ({ name: `s${i}` })) }, 'sounds.sfx must be an array of at most 16 sound effects'],
  ['too many beds', { beds: Array.from({ length: 9 }, (_, i) => ({ name: `b${i}` })) }, 'sounds.beds must be an array of at most 8 music beds'],
  ['a non-object sfx item', { sfx: ['bark'] }, 'sounds.sfx[0] must be an object'],
  ['an unknown sfx key', { sfx: [{ name: 'bark', command: ['x'] }] }, 'sounds.sfx[0].command is not a known key (name, note)'],
  ['an unknown bed key', { beds: [{ name: 'b', loop: true }] }, 'sounds.beds[0].loop is not a known key (name, note, command)'],
  ['a bad name', { sfx: [{ name: 'Bark' }] }, 'sounds.sfx[0].name must match /^[a-z][a-z0-9-]{0,31}$/'],
  ['a missing name', { beds: [{ note: 'x' }] }, 'sounds.beds[0].name must match /^[a-z][a-z0-9-]{0,31}$/'],
  ['a Windows reserved name', { sfx: [{ name: 'com1' }] }, 'sounds.sfx[0].name "com1" is a reserved file name'],
  ['a built-in effect name', { beds: [{ name: 'chime' }] }, 'sounds.beds[0].name "chime" is a built-in sound (whoosh, pop, chime, click)'],
  ['a built-in style name', { beds: [{ name: 'professional' }] }, 'sounds.beds[0].name "professional" is a built-in style (Professional, Fun, Animated whiteboard, Kinetic typography)'],
  ['a duplicate within sfx', { sfx: [{ name: 'bark' }, { name: 'bark' }] }, 'sounds.sfx[1].name "bark" duplicates sounds.sfx[0].name'],
  ['a duplicate across sfx and beds', { sfx: [{ name: 'bark' }], beds: [{ name: 'bark' }] }, 'sounds.beds[0].name "bark" duplicates sounds.sfx[0].name'],
  ['an empty note', { sfx: [{ name: 'bark', note: '' }] }, 'sounds.sfx[0].note must be a 1-200 char string'],
  ['a long note', { beds: [{ name: 'b', note: 'x'.repeat(201) }] }, 'sounds.beds[0].note must be a 1-200 char string'],
  ['a non-string note', { sfx: [{ name: 'bark', note: 3 }] }, 'sounds.sfx[0].note must be a 1-200 char string'],
  ['a non-array command', { beds: [{ name: 'b', command: 'bin/bed {lengthS} {out}' }] }, 'sounds.beds[0].command must be a non-empty string[]'],
  ['an empty command', { beds: [{ name: 'b', command: [] }] }, 'sounds.beds[0].command must be a non-empty string[]'],
  ['a non-string command arg', { beds: [{ name: 'b', command: ['x', 1] }] }, 'sounds.beds[0].command must be a non-empty string[]'],
  ['an empty program', { beds: [{ name: 'b', command: ['', '{lengthS}', '{out}'] }] }, 'sounds.beds[0].command[0] must be a program name'],
  ['no {lengthS}', { beds: [{ name: 'b', command: ['x', '{out}'] }] }, 'sounds.beds[0].command must contain a {lengthS} placeholder'],
  ['no {out}', { beds: [{ name: 'b', command: ['x', '{lengthS}'] }] }, 'sounds.beds[0].command must contain an {out} placeholder'],
])('validateSounds refuses %s', (_title, input, reason) => {
  expect(validateSounds(input)).toBe(reason);
});

test('validateSounds: a 200-char note and a 32-char name are allowed', () => {
  expect(validateSounds({ sfx: [{ name: `a${'b'.repeat(31)}`, note: 'x'.repeat(200) }] })).toBeNull();
  expect(validateSounds({ sfx: [{ name: `a${'b'.repeat(32)}` }] })).toMatch(/^sounds\.sfx\[0\]\.name must match/);
});

test('validateMemberSfx accepts built-in effects and sounds.sfx names', () => {
  expect(validateMemberSfx(['bark', 'pop'], 'cast[0].sfx', VALID)).toBeNull();
  expect(validateMemberSfx(['whoosh'], 'cast[0].sfx', undefined)).toBeNull();
  expect(validateMemberSfx(['whoosh', 'pop', 'chime', 'click', 'bark'], 'cast[0].sfx', VALID)).toBeNull();
});

test.each([
  ['an empty array', [], VALID, 'cast[0].sfx must be an array of 1-8 sound names'],
  ['a non-array', 'bark', VALID, 'cast[0].sfx must be an array of 1-8 sound names'],
  ['too many names', Array(9).fill('pop'), VALID, 'cast[0].sfx must be an array of 1-8 sound names'],
  ['a non-string', ['pop', 3], VALID, 'cast[0].sfx must be an array of 1-8 sound names'],
  ['a repeat', ['pop', 'bark', 'pop'], VALID, 'cast[0].sfx[2] "pop" repeats cast[0].sfx[0]'],
  ['a bed name', ['calm-keys'], VALID, 'cast[0].sfx[0] "calm-keys" is not a built-in sound (whoosh, pop, chime, click) or one of sounds.sfx (bark)'],
  ['an unknown name', ['pop', 'meow'], VALID, 'cast[0].sfx[1] "meow" is not a built-in sound (whoosh, pop, chime, click) or one of sounds.sfx (bark)'],
  ['an unknown name with no sounds', ['bark'], undefined, 'cast[0].sfx[0] "bark" is not a built-in sound (whoosh, pop, chime, click) or one of sounds.sfx (none)'],
])('validateMemberSfx refuses %s', (_title, sfx, sounds, reason) => {
  expect(validateMemberSfx(sfx, 'cast[0].sfx', sounds)).toBe(reason);
});

test('fileBackedSoundNames lists sfx then beds without a command', () => {
  expect(fileBackedSoundNames({ sounds: VALID })).toEqual(['bark', 'calm-keys']);
  expect(fileBackedSoundNames({})).toEqual([]);
  expect(fileBackedSoundNames(null)).toEqual([]);
});

test('findProjectSound finds an sfx or a bed, else null', () => {
  const c = { sounds: VALID };
  expect(findProjectSound(c, 'bark')).toEqual({ kind: 'sfx', entry: VALID.sfx[0] });
  expect(findProjectSound(c, 'bright-loop')).toEqual({ kind: 'bed', entry: VALID.beds[1] });
  expect(findProjectSound(c, 'pop')).toBeNull();
  expect(findProjectSound({}, 'bark')).toBeNull();
});

test.each([
  ['16-bit PCM mono', {}],
  ['16-bit PCM stereo', { ch: 2 }],
  ['32-bit float mono', { tag: 3, bits: 32 }],
])('checkSoundWav accepts %s', (_title, opts) => {
  expect(wavFormatError(wav(opts), 'sounds/bark.wav')).toBeNull();
  expect(checkSoundWav(wav(opts), 'sounds/bark.wav', 'sfx')).toBeNull();
  expect(checkSoundWav(wav(opts), 'sounds/bark.wav', 'bed')).toBeNull();
});

test.each([
  ['a non-buffer', 'RIFF', 'bark.wav is not a RIFF WAV'],
  ['a short buffer', Buffer.from('RIFF'), 'bark.wav is not a RIFF WAV'],
  ['not RIFF', wav({ riff: 'RIFX' }), 'bark.wav is not a RIFF WAV'],
  ['no fmt chunk', wav({ omitFmt: true }), 'bark.wav has no fmt chunk'],
  ['no data chunk', wav({ omitData: true }), 'bark.wav has no data chunk'],
  ['a format tag of 2', wav({ tag: 2 }), 'bark.wav WAV format tag 2 is not PCM or IEEE float'],
  ['3 channels', wav({ ch: 3 }), 'bark.wav WAV must be mono or stereo, not 3 channels'],
  ['0 channels', wav({ ch: 0 }), 'bark.wav WAV must be mono or stereo, not 0 channels'],
  ['a 4000 Hz rate', wav({ sr: 4000 }), 'bark.wav WAV sample rate 4000 Hz is outside 8000-192000'],
  ['a 200000 Hz rate', wav({ sr: 200000 }), 'bark.wav WAV sample rate 200000 Hz is outside 8000-192000'],
  ['12-bit samples', wav({ bits: 12 }), 'bark.wav WAV has 12-bit samples'],
  ['no sample frame', wav({ frames: 0 }), 'bark.wav has no audio samples'],
])('checkSoundWav refuses %s', (_title, buf, reason) => {
  expect(wavFormatError(buf, 'bark.wav')).toBe(reason);
  expect(checkSoundWav(buf, 'bark.wav', 'sfx')).toBe(reason);
});

test('wavFormatError accepts the other allowed tags and bit depths', () => {
  expect(wavFormatError(wav({ tag: 0xfffe, bits: 24 }), 'x')).toBeNull();
  expect(wavFormatError(wav({ bits: 8 }), 'x')).toBeNull();
  expect(wavFormatError(wav({ tag: 3, bits: 64, sr: 8000 }), 'x')).toBeNull();
  expect(wavFormatError(wav({ sr: 192000 }), 'x')).toBeNull();
});

test('checkSoundWav refuses a WAV over its kind\'s byte cap', () => {
  const sfxBig = wav({ frames: Math.ceil(ps.MAX_SFX_WAV_BYTES / 2) });
  expect(checkSoundWav(sfxBig, 'bark.wav', 'sfx')).toBe(`bark.wav is ${sfxBig.length} bytes, over the 1048576-byte limit for a sound effect`);
  expect(checkSoundWav(sfxBig, 'bark.wav', 'bed')).toBeNull();
  const bedBig = wav({ frames: Math.ceil(ps.MAX_BED_WAV_BYTES / 2) });
  expect(checkSoundWav(bedBig, 'calm.wav', 'bed')).toBe(`calm.wav is ${bedBig.length} bytes, over the 12582912-byte limit for a music bed`);
});

test('soundFile and soundsDir live under characterDir/sounds', () => {
  const root = path.join(os.tmpdir(), 'sm-project-sounds-root');
  expect(soundsDir(root)).toBe(path.join(characterDir(root), 'sounds'));
  expect(soundFile(root, 'bark')).toBe(path.join(characterDir(root), 'sounds', 'bark.wav'));
  expect(() => soundFile(root, '../evil')).toThrow('soundFile: invalid sound name "../evil"');
  expect(() => soundFile(root, 'Bark')).toThrow(/invalid sound name/);
});
