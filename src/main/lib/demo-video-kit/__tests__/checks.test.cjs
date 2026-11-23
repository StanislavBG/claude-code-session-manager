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
  it('html limits: own playback controls fail with the reason', () => {
    const clean = HTML(30);
    expect(c.checkHtmlLimits({ html: clean, lengthS: 30 }).ok).toBe(true);
    for (const [frag, what] of [
      ['<button id="play">Play</button>', 'button'],
      ['<INPUT type="range">', 'input'],
      ['<audio src="a.mp3" controls></audio>', 'audio controls'],
      ['<Video CONTROLS src="v.mp4"></video>', 'video controls'],
    ]) {
      const r = c.checkHtmlLimits({ html: clean + frag, lengthS: 30 });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain(`own playback controls: ${what}`);
    }
    expect(c.checkHtmlLimits({ html: clean + '<audio src="a.mp3"></audio>', lengthS: 30 }).ok).toBe(true);
  });
  it('html limits: the injected player bridge is not counted', () => {
    const { injectPlayerBridge } = require('../../project-pages/playerBridge.cjs');
    const bridged = injectPlayerBridge(`<html><head></head><body>${HTML(30)}</body></html>`);
    expect(bridged).toContain('data-sm-player-bridge');
    expect(c.checkHtmlLimits({ html: bridged, lengthS: 30 }).ok).toBe(true);
    const bridgedWithButton = '<script data-sm-player-bridge>var s="<button>";</script>' + HTML(30);
    expect(c.checkHtmlLimits({ html: bridgedWithButton, lengthS: 30 }).ok).toBe(true);
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

describe('demo-video-kit TikTok checks', () => {
  const frame = (t, lumaMean, lumaStdDev, textBoxes = []) => ({ t, lumaMean, lumaStdDev, lumaStddev: lumaStdDev, textBoxes });
  it('TIKTOK_CHECK_IDS is frozen and ordered', () => {
    expect(c.TIKTOK_CHECK_IDS).toEqual(['tiktok-hook', 'tiktok-cadence', 'tiktok-payoff', 'tiktok-loop', 'tiktok-safe-zone', 'tiktok-post-caption']);
    expect(Object.isFrozen(c.TIKTOK_CHECK_IDS)).toBe(true);
  });
  it('hook: passes at 3.0 s, fails at 3.1 s and when missing', () => {
    const r = c.checkHookBy(3);
    expect(r).toMatchObject({ id: 'tiktok-hook', ok: true });
    expect(typeof r.detail).toBe('string');
    expect(c.checkHookBy(3.1).ok).toBe(false);
    expect(c.checkHookBy(undefined).ok).toBe(false);
  });
  it('cadence: passes with gaps <= 3 s, fails with a 3.5 s gap (incl. edges at 0 and lengthS)', () => {
    expect(c.checkCutCadence([3, 6, 9, 12, 15], 18)).toMatchObject({ id: 'tiktok-cadence', ok: true });
    expect(c.checkCutCadence([3, 6.5, 9], 12).ok).toBe(false);
    expect(c.checkCutCadence([3, 6], 9.5).ok).toBe(false); // last gap 6 -> 9.5
    expect(c.checkCutCadence([], 10).ok).toBe(false);
  });
  it('payoff: passes inside the last 5 s, fails before it', () => {
    expect(c.checkPayoff(25, 30)).toMatchObject({ id: 'tiktok-payoff', ok: true });
    expect(c.checkPayoff(24.9, 30).ok).toBe(false);
    expect(c.checkPayoff(null, 30).ok).toBe(false);
  });
  it('loop: needs a late loop beat and a last frame within tolerance of the first', () => {
    const tol = c.LOOP_LUMA_TOLERANCE;
    const ok = [frame(0, 100, 40), frame(1, 30, 5), frame(30, 100 + tol, 40 - tol)];
    expect(c.checkLoopEnding(28, 30, ok)).toMatchObject({ id: 'tiktok-loop', ok: true });
    expect(c.checkLoopEnding(27.9, 30, ok).ok).toBe(false);
    expect(c.checkLoopEnding(29, 30, [frame(0, 100, 40), frame(30, 100 + tol + 0.5, 40)]).ok).toBe(false);
    expect(c.checkLoopEnding(29, 30, [frame(0, 100, 40), frame(30, 100, 40 + tol + 0.5)]).ok).toBe(false);
    expect(c.checkLoopEnding(29, 30, [frame(0, 100, 40)]).ok).toBe(false);
  });
  it('safe zone: passes inside, fails below 80% height or right of 85% width and names frame + text', () => {
    const inside = [frame(0, 1, 1, [{ text: 'Hi', x: 0.1, y: 0.1, w: 0.75, h: 0.7 }])];
    expect(c.checkSafeZone(inside)).toMatchObject({ id: 'tiktok-safe-zone', ok: true });
    const low = [frame(0, 1, 1, []), frame(1.5, 1, 1, [{ text: 'Low line', x: 0.1, y: 0.7, w: 0.3, h: 0.15 }])];
    const r = c.checkSafeZone(low);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/1\.5s/);
    expect(r.detail).toMatch(/Low line/);
    expect(c.checkSafeZone([frame(0, 1, 1, [{ text: 'Wide', x: 0.5, y: 0.1, w: 0.4, h: 0.1 }])]).ok).toBe(false);
  });
  it('post caption: passes a short question with 2 hashtags and 1 emoji', () => {
    expect(c.checkPostCaption('Ever lost a whole day to one 🐛 bug? #coding #dev')).toMatchObject({ id: 'tiktok-post-caption', ok: true });
    expect(c.checkPostCaption('Would you try this?').ok).toBe(true);
  });
  it('post caption: fails 3 hashtags, ending in ".", over 150 chars, URL, 2 emoji, empty', () => {
    expect(c.checkPostCaption('Would you try this? #a #b #c').ok).toBe(false);
    expect(c.checkPostCaption('This is how I fix bugs. #coding').ok).toBe(false);
    expect(c.checkPostCaption(`${'a'.repeat(150)}?`).ok).toBe(false);
    expect(c.checkPostCaption('See https://example.com for more?').ok).toBe(false);
    expect(c.checkPostCaption('Would you? 🐛🔥').ok).toBe(false);
    expect(c.checkPostCaption('').ok).toBe(false);
  });
  it('runChecks runs all six with input.tiktok, and is unchanged without it', () => {
    const base = { captions: ['short one'], lengthS: 12, frames: [frame(0, 100, 40), frame(12, 100, 40)] };
    const without = c.runChecks(base);
    expect(without.map((x) => x.id)).toEqual(['captions', 'blankFrames']);
    const withT = c.runChecks({ ...base, tiktok: { beats: { hook: 1, payoff: 9, loop: 11 }, cuts: [3, 6, 9], postCaption: 'Would you try it? #a' } });
    expect(withT.slice(0, 2)).toEqual(without);
    expect(withT.slice(2).map((x) => x.id)).toEqual([...c.TIKTOK_CHECK_IDS]);
    expect(withT.every((x) => x.ok)).toBe(true);
  });
});
