/**
 * projectSoundsEndToEnd.test.cjs — project sounds, end to end: a persona with a project
 * effect, a file bed, a command bed and a voiceless cast member is saved through
 * POST /admin/project-home/character/write, then the kit's sound.cjs CLI (as the
 * demo-video builder runs it) mixes cues and beds that name those sounds.
 *
 * Run: timeout 400 npx vitest run src/main/__tests__/projectSoundsEndToEnd.test.cjs
 */

'use strict';

import { describe, it, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../config.cjs');
const { registerAdminRoute } = require('../lib/feedback-remote/projectHomeAdminRoutes.cjs');

const SOUND_CLI = path.resolve(__dirname, '../lib/demo-video-kit/sound.cjs');
const CHARACTER_URL = '/admin/project-home/character/write';
const SR = 44100;

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 10000 }).status === 0;

const tmpDirs = [];
afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fsp.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectCwd() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-project-sounds-e2e-'));
  config.addAllowedRoot(dir);
  fs.mkdirSync(path.join(dir, 'session-manager-operations'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

async function mkScratchDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-project-sounds-spec-'));
  tmpDirs.push(dir);
  return dir;
}

/** Fake adminHttp stub: captures registered routes and invokes one directly. */
function makeFakeAdminHttp() {
  const routes = new Map();
  return {
    registerRoute(method, url, handler) {
      routes.set(`${method} ${url}`, handler);
    },
    async call(method, url, { body } = {}) {
      const handler = routes.get(`${method} ${url}`);
      if (!handler) throw new Error(`no route registered for ${method} ${url}`);
      const text = body !== undefined ? JSON.stringify(body) : '';
      const chunks = text ? [Buffer.from(text)] : [];
      const req = {
        on(event, cb) {
          if (event === 'data') chunks.forEach((c) => cb(c));
          if (event === 'end') cb();
          return req;
        },
      };
      let status = null;
      let payload = null;
      const res = {
        writeHead(s) { status = s; },
        end(b) { payload = b ? JSON.parse(b) : null; },
      };
      await handler(req, res, new URLSearchParams());
      return { status, body: payload };
    },
  };
}

/** A 16-bit PCM mono 44.1 kHz WAV of `seconds` of a `hz` sine at `amp`. */
function toneWav(seconds, hz, amp) {
  const n = Math.round(seconds * SR);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * hz * (i / SR)) * 32767), 44 + i * 2);
  }
  return buf;
}

function synthNarration(file, seconds) {
  const n = Math.round(seconds * SR);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const gate = (t % 1.5) < 1.0 ? 1 : 0;
    const v = gate * 0.3 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

/** The command bed: `node bin/bed.cjs <name> <lengthS> <seed> <out>` writes Number(lengthS) + 0.5 s of WAV. */
const BED_STUB = `'use strict';
const fs = require('node:fs');
const [, , name, lengthS, seed, out] = process.argv;
const sr = 44100;
const n = Math.round((Number(lengthS) + 0.5) * sr);
const hz = 110 + (Number(seed) % 7) * 10 + name.length;
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(0.4 * Math.sin(2 * Math.PI * hz * (i / sr)) * 32767), 44 + i * 2);
fs.writeFileSync(out, buf);
`;

const PERSONA = {
  name: 'Bit',
  palette: ['#fff', '#000'],
  voice: { engine: 'kokoro', id: 'af_heart' },
  sounds: {
    sfx: [{ name: 'bark' }],
    beds: [{ name: 'hum' }, { name: 'loop', command: [process.execPath, 'bin/bed.cjs', '{name}', '{lengthS}', '{seed}', '{out}'] }],
  },
  cast: [{ name: 'Rex', sfx: ['bark'] }],
};

/** Saves PERSONA (with bark + hum WAVs and the bed stub) into a fresh temp project. */
async function savePersona() {
  const cwd = await mkProjectCwd();
  fs.mkdirSync(path.join(cwd, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'bin', 'bed.cjs'), BED_STUB);
  const adminHttp = makeFakeAdminHttp();
  registerAdminRoute(adminHttp);
  const sounds = {
    bark: toneWav(0.4, 300, 0.6).toString('base64'),
    hum: toneWav(1, 220, 0.5).toString('base64'),
  };
  const r = await adminHttp.call('POST', CHARACTER_URL, {
    body: { cwd, json: PERSONA, js: 'window.character={mount(){},pose(){},mouth(){}};', sounds },
  });
  return { cwd, r };
}

/** Writes a spec + narration into a scratch dir and runs the sound.cjs CLI on it. */
async function runSoundCli(projectRoot, overrides) {
  const scratch = await mkScratchDir();
  const narrationWav = path.join(scratch, 'narration.wav');
  synthNarration(narrationWav, 4);
  const out = path.join(scratch, 'mix.wav');
  const spec = {
    narrationWav,
    cues: [{ name: 'bark', t: 1 }, { name: 'pop', t: 2 }],
    lengthS: 6,
    out,
    projectRoot,
    ...overrides,
  };
  const specPath = path.join(scratch, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec));
  const r = spawnSync(process.execPath, [SOUND_CLI, specPath], { cwd: scratch, timeout: 60000, encoding: 'utf8' });
  return { r, out };
}

describe.skipIf(!hasFfmpeg)('project sounds end to end', () => {
  it('saves the persona, then mixes project cues over the command bed and the file bed', async () => {
    const { cwd, r } = await savePersona();
    expect(r.status).toBe(200);
    expect(r.body.sounds).toEqual(['bark', 'hum']);

    for (const bed of ['loop', 'hum']) {
      const { r: run, out } = await runSoundCli(cwd, { bed });
      expect({ bed, status: run.status, stderr: run.stderr }).toEqual({ bed, status: 0, stderr: '' });
      const m = JSON.parse(run.stdout.trim());
      expect(m.lufs).toBeGreaterThan(-15.5);
      expect(m.lufs).toBeLessThan(-12.5);
      expect(m.truePeakDb).toBeLessThanOrEqual(-1.0);
      expect(fs.statSync(out).size).toBeGreaterThan(44);
    }
  }, 180000);

  it('exits 1 naming an unknown cue or bed and writes no out file', async () => {
    const { cwd, r } = await savePersona();
    expect(r.status).toBe(200);

    const sfx = await runSoundCli(cwd, { bed: 'hum', cues: [{ name: 'meow', t: 1 }] });
    expect(sfx.r.status).toBe(1);
    expect(sfx.r.stderr).toContain('unknown sfx: meow');
    expect(fs.existsSync(sfx.out)).toBe(false);

    const bed = await runSoundCli(cwd, { bed: 'nope' });
    expect(bed.r.status).toBe(1);
    expect(bed.r.stderr).toContain('unknown bed: nope');
    expect(fs.existsSync(bed.out)).toBe(false);
  }, 120000);
});
