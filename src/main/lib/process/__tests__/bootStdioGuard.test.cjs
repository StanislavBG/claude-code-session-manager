import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { installBootStdioGuard, createUncaughtExceptionHandler } = require('../bootStdioGuard.cjs');

function fakeStream() {
  const s = new EventEmitter();
  s.write = vi.fn(() => true);
  return s;
}
const eio = () => Object.assign(new Error('write EIO'), { syscall: 'write', code: 'EIO' });

describe('installBootStdioGuard', () => {
  it('does not require logs at install; logs once on a dead stream, then drops writes', () => {
    const stdout = fakeStream();
    const stderr = fakeStream();
    const writeLine = vi.fn();
    const requireLogs = vi.fn(() => ({ writeLine }));
    installBootStdioGuard({ streams: [{ name: 'stdout', stream: stdout }, { name: 'stderr', stream: stderr }], requireLogs });
    expect(requireLogs).not.toHaveBeenCalled();
    stderr.emit('error', eio());
    expect(writeLine).toHaveBeenCalledTimes(1);
    expect(writeLine).toHaveBeenCalledWith({
      scope: 'main', level: 'warn', message: 'stdio stream dead; output to it is dropped',
      meta: { stream: 'stderr', code: 'EIO' },
    });
    expect(() => stderr.write('x')).not.toThrow();
  });

  it('never throws when requireLogs throws', () => {
    const stderr = fakeStream();
    const requireLogs = () => { throw new Error('no electron'); };
    expect(() => installBootStdioGuard({ streams: [{ name: 'stdout', stream: fakeStream() }, { name: 'stderr', stream: stderr }], requireLogs })).not.toThrow();
    expect(() => stderr.emit('error', eio())).not.toThrow();
  });
});

describe('createUncaughtExceptionHandler', () => {
  it('reports a dead-stdio error only once', () => {
    const reportError = vi.fn();
    const writeLine = vi.fn();
    const h = createUncaughtExceptionHandler({ reportError, writeLine });
    h(eio());
    h(eio());
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(writeLine).toHaveBeenCalledTimes(1);
    expect(writeLine.mock.calls[0][0]).toMatchObject({ scope: 'main', level: 'error', message: 'uncaughtException' });
  });

  it('reports every ordinary error', () => {
    const reportError = vi.fn();
    const writeLine = vi.fn();
    const h = createUncaughtExceptionHandler({ reportError, writeLine });
    h(new Error('a'));
    h(new Error('a'));
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(writeLine).toHaveBeenCalledTimes(2);
  });

  it('still logs when reportError throws', () => {
    const writeLine = vi.fn();
    const h = createUncaughtExceptionHandler({ reportError: () => { throw new Error('t'); }, writeLine });
    expect(() => h(new Error('boom'))).not.toThrow();
    expect(writeLine).toHaveBeenCalledTimes(1);
  });
});
