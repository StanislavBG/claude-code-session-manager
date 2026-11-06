'use strict';
// Demo-video kit character: a project's mascot lives in
// <ops>/project-pages/videos/_character/{character.json,character.js}.
// Reading is plain file reading; writing goes only through the
// POST /admin/project-home/character/write route (writer 'project-home').
// speakWithCommand spawns the user's TTS argv directly — never through a shell.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { opsPath } = require('../opsOwnership.cjs');

const MAX_JS_BYTES = 300 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const COMMAND_TIMEOUT_MS = 120000;

/** -> null when `c` is a valid character.json object, else a reason string. */
function validateCharacterJson(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'character.json must be an object';
  if (typeof c.name !== 'string' || !c.name.trim()) return 'name must be a non-empty string';
  if (!Array.isArray(c.palette) || c.palette.length === 0 || !c.palette.every((p) => typeof p === 'string' && p)) {
    return 'palette must be a non-empty array of strings';
  }
  const v = c.voice;
  if (!v || typeof v !== 'object') return 'voice is required';
  if (v.engine === 'kokoro') {
    if (typeof v.id !== 'string' || !v.id) return 'voice.id must be a non-empty string for engine kokoro';
    return null;
  }
  if (v.engine === 'command') {
    const cmd = v.command;
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === 'string')) {
      return 'voice.command must be a non-empty string[]';
    }
    if (!cmd[0]) return 'voice.command[0] must be a program name';
    if (!cmd.some((a) => a.includes('{text}'))) return 'voice.command must contain a {text} placeholder';
    if (!cmd.some((a) => a.includes('{out}'))) return 'voice.command must contain an {out} placeholder';
    return null;
  }
  return "voice.engine must be 'kokoro' or 'command'";
}

/** -> null when `js` is acceptable character.js source, else a reason. Needs the
 * route's network checks, so they are injected (avoids a require cycle). */
function validateCharacterJs(js, networkChecks = []) {
  if (typeof js !== 'string' || !js.trim()) return 'js must be a non-empty string';
  if (Buffer.byteLength(js, 'utf8') > MAX_JS_BYTES) return `js exceeds the ${MAX_JS_BYTES}-byte limit`;
  for (const { re, message } of networkChecks) {
    if (re.test(js)) return `js must not be network-capable: ${message}`;
  }
  return null;
}

function characterDir(projectRoot) {
  return opsPath(projectRoot, 'project-pages', 'videos', '_character');
}

/** -> {json, js} | null (absent or invalid). */
function readCharacter(projectRoot) {
  try {
    const dir = characterDir(projectRoot);
    const jsonRaw = fs.readFileSync(path.join(dir, 'character.json'), 'utf8');
    if (Buffer.byteLength(jsonRaw, 'utf8') > MAX_JSON_BYTES) return null;
    const json = JSON.parse(jsonRaw);
    if (validateCharacterJson(json)) return null;
    const js = fs.readFileSync(path.join(dir, 'character.js'), 'utf8');
    if (!js.trim()) return null;
    return { json, js };
  } catch {
    return null;
  }
}

/** Substitute {text}/{out} into each argv element; the argv is never joined. */
function buildCommandArgv(voice, text, out) {
  return voice.command.map((a) => a.split('{text}').join(text).split('{out}').join(out));
}

/** Run the voice command (no shell). -> {ok, status, error?} */
function speakWithCommand(voice, text, out) {
  if (!voice || voice.engine !== 'command' || validateCharacterJson({ name: 'x', palette: ['x'], voice })) {
    return { ok: false, status: null, error: 'not a valid command voice' };
  }
  const [bin, ...args] = buildCommandArgv(voice, String(text), String(out));
  const r = spawnSync(bin, args, { shell: false, stdio: 'ignore', timeout: COMMAND_TIMEOUT_MS });
  if (r.error) return { ok: false, status: r.status, error: r.error.message };
  return { ok: r.status === 0, status: r.status, ...(r.status === 0 ? {} : { error: `exit ${r.status}` }) };
}

module.exports = {
  readCharacter,
  speakWithCommand,
  buildCommandArgv,
  validateCharacterJson,
  validateCharacterJs,
  characterDir,
  MAX_JS_BYTES,
};
