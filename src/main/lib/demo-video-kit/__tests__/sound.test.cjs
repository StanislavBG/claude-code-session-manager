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
});
