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
