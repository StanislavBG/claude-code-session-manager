import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'index.cjs'), 'utf8');

describe('index.cjs boot wiring of stdioGuard', () => {
  it('installs guardStdio before any stderr write or electron require', () => {
    const guard = SRC.indexOf('guardStdio(');
    const stderrWrite = SRC.indexOf('process.stderr.write');
    const electron = SRC.indexOf("require('electron')");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(stderrWrite).toBeGreaterThan(guard);
    expect(electron).toBeGreaterThan(guard);
  });

  it('guard log requires logs.cjs lazily and never touches console/stdio', () => {
    const guard = SRC.indexOf('guardStdio(');
    const end = SRC.indexOf('SM_BOOT_DIAG');
    const block = SRC.slice(guard, end);
    expect(block).toContain("require('./logs.cjs').writeLine(");
    expect(block).not.toMatch(/console\.|process\.std(out|err)/);
  });

  it('uncaughtException handler is gated by createUncaughtReportFilter', () => {
    expect(SRC).toContain('createUncaughtReportFilter()');
    const start = SRC.indexOf("process.on('uncaughtException'");
    expect(start).toBeGreaterThan(0);
    const end = SRC.indexOf("process.on('unhandledRejection'", start);
    const body = SRC.slice(start, end);
    expect(body).toMatch(/if \(shouldReportUncaught\(err\)\)/);
  });
});
