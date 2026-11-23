'use strict';
// Demo-video kit character: a project's mascot lives in
// <ops>/project-pages/videos/_character/{character.json,character.js}.
// Reading is plain file reading; writing goes only through the
// POST /admin/project-home/character/write route (writer 'project-home').
// speakWithCommand spawns the user's TTS argv directly — never through a shell.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Kit files are seeded to ~/.claude/session-manager/demo-video-kit/ and must
// load standalone: node built-ins and this folder only (no ../opsOwnership.cjs).
// Allowlisted for this literal in scripts/check-ops-path-literals.cjs ALLOWLIST.
const OPS_ROOT_DIR = 'session-manager-operations';

const MAX_JS_BYTES = 300 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
// Per narration line: slow CPU voices can take minutes for one sentence.
const COMMAND_TIMEOUT_MS = 900000;
const STDERR_TAIL = 500;
const WAV_HEADER_BYTES = 44;

const PERSONALITY_TEXT = Object.freeze({ who: 400, speech: 400, readingLevel: 40 });
const NEVER_SAY_MAX_ITEMS = 40;
const NEVER_SAY_MAX_CHARS = 40;

/** -> null when `p` is a valid personality object, else a reason string. */
function validatePersonality(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'personality must be an object';
  for (const k of Object.keys(p)) {
    if (k === 'neverSay') continue;
    const max = PERSONALITY_TEXT[k];
    if (!max) return `personality.${k} is not a known key (who, speech, readingLevel, neverSay)`;
    const v = p[k];
    if (typeof v !== 'string' || v.length < 1 || v.length > max) return `personality.${k} must be a 1-${max} char string`;
  }
  if ('neverSay' in p) {
    const n = p.neverSay;
    if (!Array.isArray(n) || n.length > NEVER_SAY_MAX_ITEMS) {
      return `personality.neverSay must be an array of at most ${NEVER_SAY_MAX_ITEMS} strings`;
    }
    if (!n.every((w) => typeof w === 'string' && w.length >= 1 && w.length <= NEVER_SAY_MAX_CHARS)) {
      return `personality.neverSay items must be 1-${NEVER_SAY_MAX_CHARS} char strings`;
    }
  }
  return null;
}

/** -> null when `c` is a valid character.json object, else a reason string. */
function validateCharacterJson(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'character.json must be an object';
  if (typeof c.name !== 'string' || !c.name.trim()) return 'name must be a non-empty string';
  if (!Array.isArray(c.palette) || c.palette.length === 0 || !c.palette.every((p) => typeof p === 'string' && p)) {
    return 'palette must be a non-empty array of strings';
  }
  if ('personality' in c) {
    const pErr = validatePersonality(c.personality);
    if (pErr) return pErr;
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

/**
 * Local stand-in for opsOwnership.opsPath(projectRoot, 'project-pages', ...):
 * requires an absolute path and normalizes a path inside the ops root back to
 * its project root, so the result always lands in
 * `<projectRoot>/session-manager-operations/project-pages/videos/_character`.
 * Callers pass an already-resolved project root; writes stay guarded by the
 * caller's writer-checked writeTextAtomic (assertOpsWrite).
 */
function characterDir(projectRoot) {
  return path.join(projectRootOf(projectRoot, 'characterDir'), OPS_ROOT_DIR, 'project-pages', 'videos', '_character');
}

/** The project root for `projectRoot` (absolute), with any ops-root suffix stripped. */
function projectRootOf(projectRoot, who = 'projectRootOf') {
  if (!projectRoot || typeof projectRoot !== 'string') throw new Error(`${who}: projectRoot is required`);
  if (!path.isAbsolute(projectRoot)) {
    throw new Error(`${who}: projectRoot must be an absolute path, got "${projectRoot}"`);
  }
  const segs = path.resolve(projectRoot).split(path.sep);
  const idx = segs.indexOf(OPS_ROOT_DIR);
  return idx === -1 ? segs.join(path.sep) : (segs.slice(0, idx).join(path.sep) || path.sep);
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

/** True when `file` exists, is larger than a bare WAV header and starts with 'RIFF'. */
function isWav(file) {
  let fd;
  try {
    if (fs.statSync(file).size <= WAV_HEADER_BYTES) return false;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    return head.toString('latin1') === 'RIFF';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Run the voice command (no shell). -> {ok, status, error?}
 * ok only when the command exited 0 AND wrote a WAV to `out`; the error carries
 * the last STDERR_TAIL chars of the command's stderr.
 */
function speakWithCommand(voice, text, out, { cwd } = {}) {
  if (!voice || voice.engine !== 'command' || validateCharacterJson({ name: 'x', palette: ['x'], voice })) {
    return { ok: false, status: null, error: 'not a valid command voice' };
  }
  const outStr = String(out);
  const [bin, ...args] = buildCommandArgv(voice, String(text), outStr);
  const r = spawnSync(bin, args, {
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
  });
  const stderr = r.stderr ? r.stderr.toString('utf8').trim().slice(-STDERR_TAIL) : '';
  const withStderr = (msg) => (stderr ? `${msg}: ${stderr}` : msg);
  if (r.error) return { ok: false, status: r.status, error: withStderr(r.error.message) };
  if (r.status !== 0) {
    const why = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    return { ok: false, status: r.status, error: withStderr(`voice command failed (${why})`) };
  }
  const outAbs = path.resolve(cwd || process.cwd(), outStr);
  if (!isWav(outAbs)) {
    return { ok: false, status: r.status, error: withStderr(`the voice command wrote no WAV to ${outAbs}`) };
  }
  return { ok: true, status: r.status };
}

/**
 * Speak every narration line with the saved character's command voice, in
 * order, cwd = the project root. No fallback voice: the first failure stops
 * the run. -> {ok: true, outs} | {ok: false, line?, error}
 */
function speakLines(projectRoot, lines) {
  let root;
  try {
    root = projectRootOf(projectRoot, 'speakLines');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: 'lines must be a non-empty array of { text, out }' };
  const ch = readCharacter(root);
  if (!ch) return { ok: false, error: `no valid saved character in ${characterDir(root)}` };
  const voice = ch.json.voice;
  if (voice.engine !== 'command') {
    return { ok: false, error: `the saved character's voice.engine is '${voice.engine}', not 'command'` };
  }
  const outs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || typeof l.text !== 'string' || !l.text || typeof l.out !== 'string' || !l.out) {
      return { ok: false, line: i, error: `line ${i} must be { text, out } with non-empty strings` };
    }
    const r = speakWithCommand(voice, l.text, l.out, { cwd: root });
    if (!r.ok) return { ok: false, line: i, error: r.error };
    outs.push(l.out);
  }
  return { ok: true, outs };
}

module.exports = {
  readCharacter,
  speakWithCommand,
  speakLines,
  buildCommandArgv,
  validateCharacterJson,
  validateCharacterJs,
  validatePersonality,
  characterDir,
  MAX_JS_BYTES,
  COMMAND_TIMEOUT_MS,
};

// CLI: node character.cjs speak spec.json   (spec { projectRoot, lines })
if (require.main === module) {
  const [cmdName, specPath] = process.argv.slice(2);
  let result;
  if (cmdName !== 'speak' || !specPath) {
    result = { ok: false, error: 'usage: node character.cjs speak spec.json' };
  } else {
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      result = speakLines(spec && spec.projectRoot, spec && spec.lines);
    } catch (e) {
      result = { ok: false, error: `cannot read spec ${specPath}: ${e.message}` };
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exitCode = 1;
  }
}
