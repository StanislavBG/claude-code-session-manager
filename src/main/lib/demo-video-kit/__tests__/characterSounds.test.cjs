'use strict';
import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateCharacterJson, inspectCharacter, characterDir } = require('../character.cjs');

const tmp = [];
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

const base = { name: 'Bit', palette: ['#fff'], voice: { engine: 'kokoro', id: 'af_heart' } };
const sounds = {
  sfx: [{ name: 'bark', note: 'Rex barks' }, { name: 'squeak' }],
  beds: [
    { name: 'garden', note: 'garden loop' },
    { name: 'synth', command: ['make-bed', '--len', '{lengthS}', '-o', '{out}'] },
  ],
};

function project(json, js = 'window.c={mount(){},pose(){},mouth(){}};') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-sounds-'));
  tmp.push(root);
  const dir = characterDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'character.json'), JSON.stringify(json));
  fs.writeFileSync(path.join(dir, 'character.js'), js);
  return root;
}

test('a persona with sounds and a member sfx validates', () => {
  const c = { ...base, sounds, cast: [{ name: 'Rex', note: 'never talks', sfx: ['bark', 'pop'] }] };
  expect(validateCharacterJson(c)).toBeNull();
});

test('a member sfx naming a built-in effect needs no sounds block', () => {
  expect(validateCharacterJson({ ...base, cast: [{ name: 'Rex', sfx: ['pop'] }] })).toBeNull();
});

test('member sfx refusals name cast[i].sfx', () => {
  const v = (sfx) => validateCharacterJson({ ...base, sounds, cast: [{ name: 'Rex', sfx }] });
  expect(v(['meow'])).toMatch(/^cast\[0\]\.sfx/);
  expect(v(['garden'])).toMatch(/^cast\[0\]\.sfx/);
  expect(v([])).toMatch(/^cast\[0\]\.sfx/);
  expect(v(['bark', 'bark'])).toMatch(/^cast\[0\]\.sfx/);
  expect(validateCharacterJson({ ...base, cast: [{ name: 'Rex', sfx: ['bark'] }] })).toMatch(/^cast\[0\]\.sfx/);
});

test('an invalid sounds block returns its sounds. reason before the cast check', () => {
  const dup = { sfx: [{ name: 'bark' }], beds: [{ name: 'bark' }] };
  expect(validateCharacterJson({ ...base, sounds: dup, cast: [{ name: 'Pip' }, { name: 'pip' }] })).toMatch(/^sounds\./);
});

test('a json without sounds or member sfx validates as before', () => {
  const probe = { name: 'Bit', palette: ['#fff'], voice: { engine: 'kokoro', id: 'af_heart' }, cast: [{ name: 'Pip' }, { name: 'pip' }] };
  expect(validateCharacterJson(probe)).toMatch(/^cast\[1\]/);
  expect(validateCharacterJson({ ...base, cast: [{ name: 'Pip', mood: 'x' }] })).toBe('cast[0].mood is not a known key (name, voice, note, sfx)');
  expect(validateCharacterJson({ ...base, cast: [{ name: 'Pip', note: 'hi' }] })).toBeNull();
});

test('inspectCharacter accepts saved sounds and refuses an invalid sounds block', () => {
  const ok = inspectCharacter(project({ ...base, sounds, cast: [{ name: 'Rex', sfx: ['bark', 'pop'] }] }));
  expect(ok.ok).toBe(true);
  const bad = inspectCharacter(project({ ...base, sounds: { sfx: [{ name: 'bark' }, { name: 'bark' }] } }));
  expect(bad.ok).toBe(false);
  expect(bad.error).toMatch(/^character\.json invalid: sounds\./);
});
