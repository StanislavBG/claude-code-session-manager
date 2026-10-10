'use strict';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { isAutoUpdateSupported, createAutoUpdater, CHECK_INTERVAL_MS } = require('../autoUpdater.cjs');

function mk(over = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = vi.fn().mockResolvedValue(undefined);
  updater.quitAndInstall = vi.fn();
  updater.setFeedURL = vi.fn();
  let busy = { busy: false };
  const au = createAutoUpdater({
    updater,
    supported: true,
    currentVersion: '1.0.0',
    isBusy: () => busy,
    getEnabled: () => true,
    setInterval,
    clearInterval,
    now: () => 42,
    log: () => {},
    ...over,
  });
  return { updater, au, setBusy: (b) => { busy = b; } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('isAutoUpdateSupported', () => {
  const ok = { packaged: true, platform: 'win32', env: {} };
  it('matrix', () => {
    expect(isAutoUpdateSupported(ok)).toBe(true);
    expect(isAutoUpdateSupported({ packaged: true, platform: 'linux', env: { APPIMAGE: '/x.AppImage' } })).toBe(true);
    expect(isAutoUpdateSupported({ packaged: true, platform: 'linux', env: {} })).toBe(false);
    expect(isAutoUpdateSupported({ packaged: true, platform: 'linux', env: { APPIMAGE: '' } })).toBe(false);
    expect(isAutoUpdateSupported({ packaged: true, platform: 'darwin', env: {} })).toBe(false);
    expect(isAutoUpdateSupported({ ...ok, packaged: false })).toBe(false);
    expect(isAutoUpdateSupported({ ...ok, env: { SM_AUTO_UPDATE: '0' } })).toBe(false);
    expect(isAutoUpdateSupported({ ...ok, env: { SM_E2E: '1' } })).toBe(false);
  });
});

describe('createAutoUpdater', () => {
  it('configures the updater, never sets a feed URL, and walks idle → checking → downloading → ready', async () => {
    const { updater, au } = mk();
    const seen = [];
    au.subscribe((s) => seen.push(s.state));
    expect(au.status().state).toBe('idle');
    au.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.1.0' });
    expect(au.status().state).toBe('downloading');
    expect(au.status().latest).toBe('1.1.0');
    updater.emit('download-progress', { percent: 55 });
    expect(au.status().progress).toBe(55);
    updater.emit('update-downloaded', { version: '1.1.0' });
    expect(au.status().state).toBe('ready');
    expect(seen).toEqual(['checking', 'downloading', 'downloading', 'ready']);
    // a check while ready is a no-op
    await au.checkNow();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it('status() is referentially stable until state changes', () => {
    const { updater, au } = mk();
    au.start();
    const a = au.status();
    expect(au.status()).toBe(a);
    updater.emit('update-not-available');
    expect(au.status()).not.toBe(a);
  });

  it('re-checks every 4 hours', () => {
    const { updater, au } = mk();
    au.start();
    updater.emit('update-not-available');
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('requestInstall while busy defers, then installs once on the first idle poll', () => {
    const { updater, au, setBusy } = mk();
    au.start();
    updater.emit('update-downloaded', { version: '1.1.0' });
    setBusy({ busy: true, reason: '2 scheduler jobs' });
    au.requestInstall({ force: false });
    expect(au.status().state).toBe('deferred');
    expect(au.status().busyReason).toBe('2 scheduler jobs');
    vi.advanceTimersByTime(60_000);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    setBusy({ busy: false });
    vi.advanceTimersByTime(60_000);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    vi.advanceTimersByTime(300_000);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('force install ignores busy; not-ready request does nothing', () => {
    const { updater, au, setBusy } = mk();
    au.start();
    au.requestInstall({ force: true });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit('update-downloaded', { version: '1.1.0' });
    setBusy({ busy: true, reason: 'terminals' });
    au.requestInstall({ force: true });
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('cancelDeferred returns to ready and stops polling', () => {
    const { updater, au, setBusy } = mk();
    au.start();
    updater.emit('update-downloaded', { version: '1.1.0' });
    setBusy({ busy: true, reason: 'x' });
    au.requestInstall({});
    au.cancelDeferred();
    expect(au.status().state).toBe('ready');
    setBusy({ busy: false });
    vi.advanceTimersByTime(180_000);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('disabled does no checks; setEnabled(true) resumes', () => {
    const { updater, au } = mk({ getEnabled: () => false });
    au.start();
    expect(au.status().state).toBe('disabled');
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    au.setEnabled(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    au.setEnabled(false);
    expect(au.status().state).toBe('disabled');
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('unsupported never touches the updater', async () => {
    const { updater, au } = mk({ supported: false });
    expect(au.status().state).toBe('unsupported');
    au.start();
    await au.checkNow();
    au.requestInstall({ force: true });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.listenerCount('error')).toBe(0);
  });

  it('check failures land in error state without throwing', async () => {
    const { updater, au } = mk();
    updater.checkForUpdates.mockRejectedValue(new Error('offline'));
    au.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(au.status().state).toBe('error');
    expect(au.status().error).toBe('offline');
    updater.checkForUpdates.mockImplementation(() => { throw new Error('boom'); });
    await au.checkNow();
    expect(au.status().error).toBe('boom');
  });

  it('module source never calls setFeedURL', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'autoUpdater.cjs'), 'utf8');
    expect(src.includes('setFeedURL')).toBe(false);
  });
});
