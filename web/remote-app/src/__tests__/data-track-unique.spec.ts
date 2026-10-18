// @vitest-environment node
// This project has no @types/node, so the node built-in imports below are untyped.
import { describe, it, expect } from 'vitest';
// @ts-ignore no @types/node
import { readdirSync, readFileSync } from 'node:fs';
// @ts-ignore no @types/node
import { resolve } from 'node:path';

declare const __dirname: string;

const srcDir = resolve(__dirname, '..');
const compDir = resolve(srcDir, 'components');
const files: string[] = [
  resolve(srcDir, 'App.tsx'),
  ...(readdirSync(compDir) as string[])
    .filter((f) => f.endsWith('.tsx'))
    .sort()
    .map((f) => resolve(compDir, f)),
];

const perFile = files.map((file) => {
  const src = readFileSync(file, 'utf8') as string;
  const tracks = [...src.matchAll(/data-track="([^"]+)"/g)].map((m) => m[1]);
  const buttons = (src.match(/<button\b/g) ?? []).length;
  return { name: file.slice(srcDir.length + 1), tracks, buttons };
});

describe('data-track tagging', () => {
  it('finds source files', () => {
    expect(perFile.length).toBeGreaterThan(1);
  });

  it('every data-track value is kebab-case <area>-<action>', () => {
    for (const f of perFile) {
      for (const t of f.tracks) expect(t, `${f.name}: ${t}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
    }
  });

  it('no data-track value appears in two different files', () => {
    const owner = new Map<string, string>();
    for (const f of perFile) {
      for (const t of new Set(f.tracks)) {
        expect(owner.has(t) ? owner.get(t) : f.name, `"${t}" duplicated`).toBe(f.name);
        owner.set(t, f.name);
      }
    }
  });

  it('every <button has a data-track literal', () => {
    for (const f of perFile) {
      expect(f.tracks.length, `${f.name}: ${f.buttons} buttons vs ${f.tracks.length} data-track`).toBe(f.buttons);
    }
  });
});
