'use strict';
import { test, expect, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCharacter, speakWithCommand, buildCommandArgv, validateCharacterJson, characterDir } = require('../character.cjs');

const tmp = [];
afterEach(() => { while (tmp.length) fs.rmSync(tmp.pop(), { recursive: true, force: true }); });

function project(json, js = 'window.c={mount(){},pose(){},mouth(){}};') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-char-'));
  tmp.push(root);
  fs.mkdirSync(path.join(root, 'session-manager-operations'), { recursive: true });
  if (json !== undefined) {
    const dir = characterDir(root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'character.json'), typeof json === 'string' ? json : JSON.stringify(json));
    if (js !== null) fs.writeFileSync(path.join(dir, 'character.js'), js);
  }
  return root;
}

const kokoro = { name: 'Bit', palette: ['#fff'], voice: { engine: 'kokoro', id: 'af_heart' } };
const cmd = { name: 'Bit', palette: ['#fff'], voice: { engine: 'command', command: ['say', '-o', '{out}', '{text}'] } };

test('valid kokoro and command characters read back', () => {
  expect(readCharacter(project(kokoro))).toMatchObject({ json: kokoro });
  expect(readCharacter(project(cmd)).json.voice.engine).toBe('command');
});

test('absent or invalid characters return null', () => {
  expect(readCharacter(project(undefined))).toBeNull();
  expect(readCharacter(project('{nope'))).toBeNull();
  expect(readCharacter(project({ ...kokoro, palette: [] }))).toBeNull();
  expect(readCharacter(project(kokoro, null))).toBeNull();
  expect(validateCharacterJson({ ...cmd, voice: { engine: 'command', command: ['say', '{text}'] } })).toMatch(/\{out\}/);
  expect(validateCharacterJson({ ...cmd, voice: { engine: 'command', command: ['say', '{out}'] } })).toMatch(/\{text\}/);
  expect(validateCharacterJson({ ...kokoro, voice: { engine: 'other' } })).toMatch(/engine/);
});

test('command argv is substituted per element, never shell-joined', () => {
  const text = 'hi; rm -rf / $(x) "q"';
  const argv = buildCommandArgv(cmd.voice, text, '/tmp/o.wav');
  expect(argv).toEqual(['say', '-o', '/tmp/o.wav', text]);
});

test('speakWithCommand runs without a shell', () => {
  const out = path.join(os.tmpdir(), `sm-char-out-${process.pid}.txt`);
  tmp.push(out);
  const voice = { engine: 'command', command: [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[2], process.argv[1])', '{text}', '{out}'] };
  const text = 'a; echo pwned $(id) `x`';
  const r = speakWithCommand(voice, text, out);
  expect(r.ok).toBe(true);
  expect(fs.readFileSync(out, 'utf8')).toBe(text);
  expect(speakWithCommand(kokoro.voice, 'x', out).ok).toBe(false);
});
