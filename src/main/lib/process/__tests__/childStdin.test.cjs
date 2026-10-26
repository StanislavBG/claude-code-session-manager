import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';

const { feedChildStdin } = require('../childStdin.cjs');

function waitClose(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('child did not close in time')), ms);
    child.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
}

describe('feedChildStdin', () => {
  it('delivers a 300 KB text byte-exactly', async () => {
    const text = 'héllo-'.repeat(50000); // > 300 KB utf8
    const child = spawn(
      process.execPath,
      ['-e', "let n=0;const c=[];process.stdin.on('data',d=>c.push(d));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(c))})"],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    expect(feedChildStdin(child, text)).toBe(true);
    await waitClose(child);
    expect(Buffer.concat(chunks).equals(Buffer.from(text, 'utf8'))).toBe(true);
    expect(Buffer.byteLength(text)).toBeGreaterThan(300 * 1024);
  }, 30000);

  it('does not throw when the child exits without reading; logs at most once', async () => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const log = [];
    expect(feedChildStdin(child, 'x'.repeat(2 * 1024 * 1024), { log: (m) => log.push(m) })).toBe(true);
    await waitClose(child);
    await new Promise((r) => setTimeout(r, 100));
    expect(log.length).toBeLessThanOrEqual(1);
  }, 30000);

  it('returns false without a child or stdin', () => {
    expect(feedChildStdin({}, 'x')).toBe(false);
    expect(feedChildStdin(null, 'x')).toBe(false);
  });
});
