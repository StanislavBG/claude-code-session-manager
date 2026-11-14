'use strict';
import { describe, it, expect } from 'vitest';
const c = require('../checks.cjs');

const HTML = (d) => `<meta name="sm-demo-duration" content="${d}"><script>window.smDemo = { scenes: [] };</script>`;

describe('demo-video-kit checks', () => {
  it('BANNED_WORDS has 35 entries', () => expect(c.BANNED_WORDS.length).toBe(35));
  it('captions: rejects 13 words, passes 12', () => {
    expect(c.checkCaptions(['one two three four five six seven eight nine ten eleven twelve thirteen']).ok).toBe(false);
    expect(c.checkCaptions(['one two three four five six seven eight nine ten eleven twelve']).ok).toBe(true);
  });
  it('language: rejects banned word, passes plain text', () => {
    expect(c.lintLanguage('We deploy your work.').ok).toBe(false);
    expect(c.lintLanguage('Your work stays on your machine. You see each step.').ok).toBe(true);
    expect(c.lintLanguage('Use the API now.').ok).toBe(false);
  });
  it('language: rejects long sentence', () => {
    expect(c.lintLanguage('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen.').ok).toBe(false);
  });
  it('closing: rejects npx and leading $, passes plain', () => {
    expect(c.checkClosing('Try it: npx foo').ok).toBe(false);
    expect(c.checkClosing('$ run it').ok).toBe(false);
    expect(c.checkClosing('Open the app and start.').ok).toBe(true);
  });
  it('voice fit: rejects 1.3x, passes 1.2x', () => {
    expect(c.checkVoiceFit([{ speechS: 6.5, sceneS: 5 }]).ok).toBe(false);
    expect(c.checkVoiceFit([{ speechS: 6, sceneS: 5 }]).ok).toBe(true);
  });
  it('speech coverage', () => {
    expect(c.checkSpeechCoverage(10, 30).ok).toBe(false);
    expect(c.checkSpeechCoverage(12, 30).ok).toBe(true);
  });
  it('blank frames: rejects blank at 0.6 s, ignores blank at 0.3 s', () => {
    expect(c.checkBlankFrames([{ t: 0.6, lumaStddev: 0.5 }]).ok).toBe(false);
    expect(c.checkBlankFrames([{ t: 0.3, lumaStddev: 0.5 }, { t: 1, lumaStddev: 40 }]).ok).toBe(true);
  });
  it('html limits', () => {
    expect(c.checkHtmlLimits({ html: HTML(30), lengthS: 30 }).ok).toBe(true);
    expect(c.checkHtmlLimits({ html: HTML(20), lengthS: 30 }).ok).toBe(false);
    expect(c.checkHtmlLimits({ html: '<p>x</p>', lengthS: 30 }).ok).toBe(false);
    expect(c.checkHtmlLimits({ html: HTML(30), bytes: 2 * 1024 * 1024 + 1, lengthS: 30 }).ok).toBe(false);
  });
  it('runChecks returns entries', () => {
    const r = c.runChecks({ captions: ['hi'], closing: 'Done.' });
    expect(r.map((x) => x.id)).toEqual(['captions', 'closing']);
    expect(r.every((x) => x.ok)).toBe(true);
  });
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { timeout: 10000 }).status === 0;
const SR = 16000;

function hum(seconds) {
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = 0.3 * Math.sin(2 * Math.PI * 131 * t) + 0.3 * Math.sin(2 * Math.PI * 196 * t);
  }
  return x;
}

// Syllable-like: noise bursts gated on/off at 4 Hz with a smooth (raised-cosine) shape.
function burstTrain(seconds) {
  const x = new Float32Array(Math.round(seconds * SR));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const env = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
    x[i] = 0.5 * env * rnd();
  }
  return x;
}

function pcm16Wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

function mp3Html(samples, dir, name) {
  const wav = path.join(dir, `${name}.wav`);
  const mp3 = path.join(dir, `${name}.mp3`);
  fs.writeFileSync(wav, pcm16Wav(samples));
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '64k', mp3], { timeout: 60000 });
  if (r.status !== 0) throw new Error(`ffmpeg encode failed: ${r.stderr}`);
  const uri = `data:audio/mpeg;base64,${fs.readFileSync(mp3).toString('base64')}`;
  return `<html><body><audio id="vo" src="${uri}"></audio></body></html>`;
}

describe('demo-video-kit audio speech check', () => {
  it('speechModulationShare: two-tone hum scores below 0.2', () => {
    expect(c.speechModulationShare(hum(6), SR)).toBeLessThan(0.2);
  });
  it('speechModulationShare: 4 Hz burst train scores above 0.3', () => {
    expect(c.speechModulationShare(burstTrain(6), SR)).toBeGreaterThan(0.3);
  });
  it('checkAudioHasSpeech: no embedded audio fails', () => {
    const r = c.checkAudioHasSpeech({ html: '<p>no audio</p>' });
    expect(r.id).toBe('audio-speech');
    expect(r.ok).toBe(false);
  });
  it('runChecks includes audio-speech when html is given', () => {
    expect(c.runChecks({ html: '<p>x</p>', lengthS: 30 }).map((x) => x.id)).toContain('audio-speech');
  });
  it.skipIf(!hasFfmpeg)('checkAudioHasSpeech decodes the embedded mp3: fails hum, passes burst train', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-test-'));
    try {
      const humR = c.checkAudioHasSpeech({ html: mp3Html(hum(6), dir, 'hum') });
      expect(humR.id).toBe('audio-speech');
      expect(humR.ok).toBe(false);
      const speechR = c.checkAudioHasSpeech({ html: mp3Html(burstTrain(6), dir, 'burst') });
      expect(speechR.ok).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120000);
});
