'use strict';
// Demo-video kit project sounds: a persona's own named sound effects and music beds —
// the `sounds` block of character.json ({ sfx: [{name,note}], beds: [{name,note,command}] })
// and a cast member's `sfx` (names of built-in effects or sounds.sfx entries).
// Every sfx entry and every bed without `command` is file-backed: its WAV lives in
// videos/_character/sounds/<name>.wav (see soundFile), written only by
// POST /admin/project-home/character/write as writer 'project-home'.
// Seeded with the kit, so it loads standalone: node built-ins and this folder only.
// sound.cjs and character.cjs are required lazily inside functions (both may require
// this module at load).
const path = require('node:path');

const SOUND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_PROJECT_SFX = 16;
const MAX_PROJECT_BEDS = 8;
const MAX_MEMBER_SFX = 8;
const SOUND_NOTE_MAX = 200;
const MAX_SFX_WAV_BYTES = 1048576;
const MAX_BED_WAV_BYTES = 12582912;
const MAX_SOUNDS_TOTAL_BYTES = 33554432;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const SFX_KEYS = Object.freeze(['name', 'note']);
const BED_KEYS = Object.freeze(['name', 'note', 'command']);

/** The kit's built-in effect and style names, from sound.cjs. */
function builtinNames() {
  const { SFX_NAMES, STYLES } = require('./sound.cjs');
  return { sfx: [...SFX_NAMES], styles: Object.keys(STYLES) };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** -> null when `sounds` is a valid character.json `sounds` block, else a reason (first failure wins). */
function validateSounds(sounds) {
  if (!isPlainObject(sounds)) return 'sounds must be an object with optional sfx and beds arrays';
  for (const k of Object.keys(sounds)) {
    if (k !== 'sfx' && k !== 'beds') return `sounds.${k} is not a known key (sfx, beds)`;
  }
  if ('sfx' in sounds && (!Array.isArray(sounds.sfx) || sounds.sfx.length > MAX_PROJECT_SFX)) {
    return `sounds.sfx must be an array of at most ${MAX_PROJECT_SFX} sound effects`;
  }
  if ('beds' in sounds && (!Array.isArray(sounds.beds) || sounds.beds.length > MAX_PROJECT_BEDS)) {
    return `sounds.beds must be an array of at most ${MAX_PROJECT_BEDS} music beds`;
  }
  const builtin = builtinNames();
  const styleKeys = builtin.styles.map((s) => s.toLowerCase());
  const seen = new Map();
  const groups = [['sfx', SFX_KEYS], ['beds', BED_KEYS]];
  for (const [group, keys] of groups) {
    const items = sounds[group] || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const label = `sounds.${group}[${i}]`;
      if (!isPlainObject(item)) return `${label} must be an object`;
      for (const k of Object.keys(item)) {
        if (!keys.includes(k)) return `${label}.${k} is not a known key (${keys.join(', ')})`;
      }
      const n = item.name;
      if (typeof n !== 'string' || !SOUND_NAME_RE.test(n)) return `${label}.name must match ${SOUND_NAME_RE}`;
      if (WINDOWS_RESERVED.test(n)) return `${label}.name "${n}" is a reserved file name`;
      if (builtin.sfx.includes(n)) return `${label}.name "${n}" is a built-in sound (${builtin.sfx.join(', ')})`;
      if (styleKeys.includes(n.toLowerCase())) return `${label}.name "${n}" is a built-in style (${builtin.styles.join(', ')})`;
      if (seen.has(n)) return `${label}.name "${n}" duplicates ${seen.get(n)}.name`;
      seen.set(n, label);
      if ('note' in item && (typeof item.note !== 'string' || item.note.length < 1 || item.note.length > SOUND_NOTE_MAX)) {
        return `${label}.note must be a 1-${SOUND_NOTE_MAX} char string`;
      }
      if (group === 'beds' && 'command' in item) {
        const cmd = item.command;
        if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === 'string')) {
          return `${label}.command must be a non-empty string[]`;
        }
        if (!cmd[0]) return `${label}.command[0] must be a program name`;
        if (!cmd.some((a) => a.includes('{lengthS}'))) return `${label}.command must contain a {lengthS} placeholder`;
        if (!cmd.some((a) => a.includes('{out}'))) return `${label}.command must contain an {out} placeholder`;
      }
    }
  }
  return null;
}

/** -> null when a cast member's `sfx` names 1-8 distinct built-in effects or sounds.sfx
 * names, else a reason prefixed with `label`. `sounds` may be undefined. */
function validateMemberSfx(sfx, label, sounds) {
  if (!Array.isArray(sfx) || sfx.length < 1 || sfx.length > MAX_MEMBER_SFX || !sfx.every((n) => typeof n === 'string')) {
    return `${label} must be an array of 1-${MAX_MEMBER_SFX} sound names`;
  }
  const builtin = builtinNames().sfx;
  const own = sounds && Array.isArray(sounds.sfx) ? sounds.sfx.map((e) => e && e.name).filter((n) => typeof n === 'string') : [];
  const firstAt = new Map();
  for (let j = 0; j < sfx.length; j++) {
    const n = sfx[j];
    if (!builtin.includes(n) && !own.includes(n)) {
      return `${label}[${j}] "${n}" is not a built-in sound (${builtin.join(', ')}) or one of sounds.sfx (${own.length ? own.join(', ') : 'none'})`;
    }
    if (firstAt.has(n)) return `${label}[${j}] "${n}" repeats ${label}[${firstAt.get(n)}]`;
    firstAt.set(n, j);
  }
  return null;
}

/** Names of every file-backed sound in character `c`: each sfx, then each bed without `command`. */
function fileBackedSoundNames(c) {
  const s = c && isPlainObject(c.sounds) ? c.sounds : null;
  if (!s) return [];
  const out = [];
  if (Array.isArray(s.sfx)) for (const e of s.sfx) if (e && typeof e.name === 'string') out.push(e.name);
  if (Array.isArray(s.beds)) for (const e of s.beds) if (e && typeof e.name === 'string' && !('command' in e)) out.push(e.name);
  return out;
}

/** -> { kind: 'sfx' | 'bed', entry } for the project sound named `name` in character `c`, else null. */
function findProjectSound(c, name) {
  const s = c && isPlainObject(c.sounds) ? c.sounds : null;
  if (!s) return null;
  const sfx = Array.isArray(s.sfx) ? s.sfx.find((e) => e && e.name === name) : undefined;
  if (sfx) return { kind: 'sfx', entry: sfx };
  const bed = Array.isArray(s.beds) ? s.beds.find((e) => e && e.name === name) : undefined;
  if (bed) return { kind: 'bed', entry: bed };
  return null;
}

/** -> null when `buf` is a readable PCM / IEEE-float WAV (headers only), else a reason prefixed with `label`. */
function wavFormatError(buf, label) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return `${label} is not a RIFF WAV`;
  }
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && !fmt && size >= 16 && body + 16 <= buf.length) {
      fmt = { tag: buf.readUInt16LE(body), ch: buf.readUInt16LE(body + 2), sr: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    }
    if (id === 'data' && !data) data = { bytes: Math.min(size, buf.length - body) };
    pos = body + size + (size % 2);
  }
  if (!fmt) return `${label} has no fmt chunk`;
  if (![1, 3, 0xfffe].includes(fmt.tag)) return `${label} WAV format tag ${fmt.tag} is not PCM or IEEE float`;
  if (fmt.ch < 1 || fmt.ch > 2) return `${label} WAV must be mono or stereo, not ${fmt.ch} channels`;
  if (fmt.sr < 8000 || fmt.sr > 192000) return `${label} WAV sample rate ${fmt.sr} Hz is outside 8000-192000`;
  if (![8, 16, 24, 32, 64].includes(fmt.bits)) return `${label} WAV has ${fmt.bits}-bit samples`;
  if (!data) return `${label} has no data chunk`;
  if (data.bytes < (fmt.ch * fmt.bits) / 8) return `${label} has no audio samples`;
  return null;
}

/** -> null when `buf` is a usable WAV within the byte cap for `kind` ('sfx' | 'bed'), else a reason. */
function checkSoundWav(buf, label, kind) {
  const cap = kind === 'sfx' ? MAX_SFX_WAV_BYTES : MAX_BED_WAV_BYTES;
  if (Buffer.isBuffer(buf) && buf.length > cap) {
    return `${label} is ${buf.length} bytes, over the ${cap}-byte limit for a ${kind === 'sfx' ? 'sound effect' : 'music bed'}`;
  }
  return wavFormatError(buf, label);
}

/** <characterDir(root)>/sounds — where every file-backed project sound's WAV lives. */
function soundsDir(root) {
  return path.join(require('./character.cjs').characterDir(root), 'sounds');
}

/** <soundsDir(root)>/<name>.wav; throws for a name not matching SOUND_NAME_RE. */
function soundFile(root, name) {
  if (typeof name !== 'string' || !SOUND_NAME_RE.test(name)) throw new Error(`soundFile: invalid sound name "${name}"`);
  return path.join(soundsDir(root), `${name}.wav`);
}

module.exports = {
  validateSounds,
  validateMemberSfx,
  fileBackedSoundNames,
  findProjectSound,
  wavFormatError,
  checkSoundWav,
  soundsDir,
  soundFile,
  SOUND_NAME_RE,
  MAX_PROJECT_SFX,
  MAX_PROJECT_BEDS,
  MAX_MEMBER_SFX,
  SOUND_NOTE_MAX,
  MAX_SFX_WAV_BYTES,
  MAX_BED_WAV_BYTES,
  MAX_SOUNDS_TOTAL_BYTES,
};
