'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const s = require('../sound.cjs');

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 10000 }).status === 0;

const FIXTURE = `
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.5 LUFS

  Loudness range:
    LRA:         3.1 LU

  True peak:
    Peak:       -1.7 dBFS
`;

function synthNarration(file, seconds) {
  const sr = 44100;
  const n = Math.round(seconds * sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const gate = (t % 1.5) < 1.0 ? 1 : 0;
    const v = gate * 0.3 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t));
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

describe('demo-video-kit sound', () => {
  it('same seed gives identical bytes, different seed differs', () => {
    const a = s.buildMusicBed({ style: 'Fun', lengthS: 3, seed: 7 });
    const b = s.buildMusicBed({ style: 'Fun', lengthS: 3, seed: 7 });
    const c = s.buildMusicBed({ style: 'Fun', lengthS: 3, seed: 8 });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    expect(a.toString('ascii', 0, 4)).toBe('RIFF');
    expect(a.readUInt16LE(20)).toBe(3);
  });
  it('every style and sfx builds', () => {
    for (const st of ['Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']) {
      expect(s.buildMusicBed({ style: st, lengthS: 1, seed: 1 }).length).toBeGreaterThan(44);
    }
    for (const n of ['whoosh', 'pop', 'chime', 'click']) expect(s.buildSfx(n).length).toBeGreaterThan(44);
    expect(() => s.buildSfx('nope')).toThrow();
  });
  for (const st of ['Professional', 'Fun', 'Animated whiteboard', 'Kinetic typography']) {
    it(`${st} 60 s bed has only finite samples`, () => {
      const wav = s.buildMusicBed({ style: st, lengthS: 60, seed: 1 });
      const n = (wav.length - 44) / 4;
      let bad = -1;
      for (let i = 0; i < n; i++) if (!Number.isFinite(wav.readFloatLE(44 + i * 4))) { bad = i; break; }
      expect(bad).toBe(-1);
    }, 60000);
  }
  it('parses ebur128 output', () => {
    expect(s.parseEbur128(FIXTURE)).toEqual({ lufs: -14.2, truePeakDb: -1.7 });
  });
  it.skipIf(!hasFfmpeg)('mix lands near -14 LUFS under the true-peak ceiling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-test-'));
    try {
      const narr = path.join(dir, 'narr.wav');
      const out = path.join(dir, 'mix.wav');
      synthNarration(narr, 8);
      const r = s.mix({ narrationWav: narr, cues: [{ name: 'whoosh', t: 0.5 }, { name: 'chime', t: 5 }], style: 'Professional', lengthS: 8, out });
      const m = s.measure(out);
      expect(m.lufs).toBeGreaterThan(-15.5);
      expect(m.lufs).toBeLessThan(-12.5);
      expect(m.truePeakDb).toBeLessThanOrEqual(-1.0);
      expect(r.speechS).toBeGreaterThan(4);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
  describe('project sfx cues', () => {
    const { characterDir } = require('../character.cjs');
    const { soundFile } = require('../projectSounds.cjs');
    const SR = 44100;

    function sineWav(file, seconds, hz) {
      const n = Math.round(seconds * SR);
      const buf = Buffer.alloc(44 + n * 2);
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
      buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
      for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(0.8 * Math.sin(2 * Math.PI * hz * i / SR) * 32767), 44 + i * 2);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    function writePersona(root, json, { wav = true } = {}) {
      const cdir = characterDir(root);
      fs.mkdirSync(cdir, { recursive: true });
      fs.writeFileSync(path.join(cdir, 'character.json'), JSON.stringify(json));
      fs.writeFileSync(path.join(cdir, 'character.js'), 'window.Character = {};\n');
      if (wav) sineWav(soundFile(root, 'zap'), 0.2, 1000);
    }
    const PERSONA = { name: 'Pesho', palette: ['#ffcc00'], voice: { engine: 'kokoro', id: 'af_heart' }, sounds: { sfx: [{ name: 'zap' }] } };
    function decode(file, dir, tag) {
      const f = path.join(dir, `${tag}.dec.wav`);
      s.runFfmpeg(['-hide_banner', '-nostats', '-y', '-i', file, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_f32le', f]);
      return s.decodeWavF32(fs.readFileSync(f));
    }
    function rms(x, fromS, lenS) {
      const a = Math.round(fromS * SR); const b = Math.min(x.length, a + Math.round(lenS * SR));
      let e = 0; for (let i = a; i < b; i++) e += x[i] * x[i];
      return Math.sqrt(e / Math.max(1, b - a));
    }
    let tmp;
    function setup(narrS = 4) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-proj-'));
      const narr = path.join(tmp, 'narr.wav');
      synthNarration(narr, narrS);
      return { root: path.join(tmp, 'proj'), narr };
    }
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

    it('rejects a relative projectRoot', () => {
      expect(() => s.mix({ narrationWav: 'x.wav', cues: [], style: 'Fun', lengthS: 1, out: 'o.wav', projectRoot: 'rel/dir' }))
        .toThrow('spec.projectRoot must be an absolute path');
    });

    it.skipIf(!hasFfmpeg)('mixes a persona sfx at its cue time at the effect gain', () => {
      // 1 s of narration in a 4 s mix: the cue at 2 s lands over the bed alone, so the
      // effect is measurable; the 0.8 s window (1.2 s earlier) is speech in both mixes.
      const { root, narr } = setup(1);
      try {
        writePersona(root, PERSONA);
        const withCue = path.join(tmp, 'with.wav');
        const without = path.join(tmp, 'without.wav');
        s.mix({ narrationWav: narr, cues: [{ name: 'zap', t: 2 }], style: 'Professional', lengthS: 4, out: withCue, projectRoot: root });
        s.mix({ narrationWav: narr, cues: [], style: 'Professional', lengthS: 4, out: without, projectRoot: root });
        const a = decode(withCue, tmp, 'a');
        const b = decode(without, tmp, 'b');
        expect(rms(a, 2, 0.2)).toBeGreaterThanOrEqual(2 * rms(b, 2, 0.2));
        const ea = rms(a, 0.8, 0.2); const eb = rms(b, 0.8, 0.2);
        expect(Math.abs(ea - eb) / eb).toBeLessThan(0.3);
      } finally { cleanup(); }
    }, 120000);

    it.skipIf(!hasFfmpeg)('built-in-only cues mix byte-identically with or without a projectRoot or persona sounds', () => {
      const { root, narr } = setup();
      try {
        const cues = [{ name: 'pop', t: 1 }, { name: 'chime', t: 2.5 }];
        const run = (tag, extra) => {
          const out = path.join(tmp, `${tag}.wav`);
          s.mix({ narrationWav: narr, cues, style: 'Fun', lengthS: 4, out, ...extra });
          return fs.readFileSync(out);
        };
        const base = run('none', {});
        expect(run('nopersona', { projectRoot: root }).equals(base)).toBe(true);
        const { sounds, ...noSounds } = PERSONA;
        writePersona(root, noSounds, { wav: false });
        expect(run('nosounds', { projectRoot: root }).equals(base)).toBe(true);
      } finally { cleanup(); }
    }, 120000);

    it.skipIf(!hasFfmpeg)('fails with a named reason before writing out', () => {
      const { root, narr } = setup();
      try {
        const out = path.join(tmp, 'out.wav');
        const go = (extra) => () => s.mix({ narrationWav: narr, cues: [{ name: 'zap', t: 1 }], style: 'Fun', lengthS: 4, out, ...extra });
        expect(go({})).toThrow(/^unknown sfx: zap \(built-in: whoosh, pop, chime, click; pass projectRoot/);
        expect(go({ projectRoot: root })).toThrow(/^unknown sfx: zap .*persona sounds\.sfx: none/);
        writePersona(root, { ...PERSONA, sounds: { sfx: [{ name: 'bark' }] } }, { wav: false });
        expect(go({ projectRoot: root })).toThrow(/^unknown sfx: zap .*persona sounds\.sfx: bark/);
        writePersona(root, PERSONA, { wav: false });
        expect(go({ projectRoot: root })).toThrow(`project sfx 'zap' has no WAV at ${soundFile(root, 'zap')}`);
        fs.mkdirSync(path.dirname(soundFile(root, 'zap')), { recursive: true });
        fs.writeFileSync(soundFile(root, 'zap'), 'not a wav');
        expect(go({ projectRoot: root })).toThrow(/^project sfx 'zap' .* is not a RIFF WAV/);
        fs.writeFileSync(path.join(characterDir(root), 'character.json'), '{bad');
        expect(go({ projectRoot: root })).toThrow(/^project persona unusable: character\.json is not valid JSON/);
        expect(fs.existsSync(out)).toBe(false);
      } finally { cleanup(); }
    }, 120000);
  });
});
