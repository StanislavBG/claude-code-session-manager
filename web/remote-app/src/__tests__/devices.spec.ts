import { beforeEach, describe, expect, it } from 'vitest';
import type { Device } from '../types';
import {
  META_PREFIX,
  PREFERRED_KEY,
  deviceLabel,
  loadDeviceMeta,
  loadPreferredDevice,
  pickActiveDevice,
  platformLabel,
  saveDeviceMeta,
  savePreferredDevice,
} from '../devices';

const dev = (deviceId: string, issuedAt: number, isOnline: boolean): Device => ({
  deviceId,
  email: 'a@b.c',
  issuedAt,
  isOnline,
});

describe('pickActiveDevice', () => {
  it('returns null for an empty list', () => {
    expect(pickActiveDevice([], null, null)).toBeNull();
    expect(pickActiveDevice([], 'x', 'y')).toBeNull();
  });
  it('keeps activeId when in list, even offline', () => {
    const ds = [dev('a', 1, false), dev('b', 2, true)];
    expect(pickActiveDevice(ds, 'a', 'b')).toBe('a');
  });
  it('ignores a stale activeId not in the list', () => {
    const ds = [dev('a', 1, true)];
    expect(pickActiveDevice(ds, 'gone', null)).toBe('a');
  });
  it('uses preferred when online', () => {
    const ds = [dev('a', 1, true), dev('b', 2, true)];
    expect(pickActiveDevice(ds, null, 'a')).toBe('a');
  });
  it('skips preferred when offline', () => {
    const ds = [dev('a', 1, false), dev('b', 2, true)];
    expect(pickActiveDevice(ds, null, 'a')).toBe('b');
  });
  it('newest online wins', () => {
    const ds = [dev('a', 1, true), dev('b', 5, true), dev('c', 9, false)];
    expect(pickActiveDevice(ds, null, null)).toBe('b');
  });
  it('null when none online and no active', () => {
    expect(pickActiveDevice([dev('a', 1, false)], null, 'a')).toBeNull();
  });
});

describe('labels', () => {
  it('deviceLabel uses trimmed name or falls back', () => {
    const m = { name: '  Desk  ', platform: null, version: null, seenAt: 1 };
    expect(deviceLabel('abcdefgh', m)).toBe('Desk');
    expect(deviceLabel('abcdefgh', { ...m, name: '   ' })).toBe('Computer abcdef');
    expect(deviceLabel('abcdefgh')).toBe('Computer abcdef');
    expect(deviceLabel('abcdefgh', null)).toBe('Computer abcdef');
  });
  it('platformLabel maps', () => {
    expect(platformLabel('darwin')).toBe('macOS');
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('win32')).toBe('Windows');
    expect(platformLabel('freebsd')).toBe('freebsd');
    expect(platformLabel('')).toBeNull();
    expect(platformLabel(null)).toBeNull();
    expect(platformLabel()).toBeNull();
  });
});

describe('storage', () => {
  beforeEach(() => localStorage.clear());

  it('preferred round-trips and null removes', () => {
    expect(loadPreferredDevice()).toBeNull();
    savePreferredDevice('d1');
    expect(localStorage.getItem(PREFERRED_KEY)).toBe('d1');
    expect(loadPreferredDevice()).toBe('d1');
    savePreferredDevice(null);
    expect(localStorage.getItem(PREFERRED_KEY)).toBeNull();
  });
  it('meta round-trips', () => {
    const m = { name: 'Mac', platform: 'darwin', version: '1.0.0', seenAt: 42 };
    saveDeviceMeta('d1', m);
    expect(loadDeviceMeta('d1')).toEqual(m);
  });
  it('meta null when missing or malformed', () => {
    expect(loadDeviceMeta('nope')).toBeNull();
    localStorage.setItem(META_PREFIX + 'bad', '{oops');
    expect(loadDeviceMeta('bad')).toBeNull();
    localStorage.setItem(META_PREFIX + 'shape', JSON.stringify({ name: 5 }));
    expect(loadDeviceMeta('shape')).toBeNull();
  });
  it('never throws when localStorage throws', () => {
    const boom = () => {
      throw new Error('denied');
    };
    const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: boom,
    });
    try {
      expect(loadPreferredDevice()).toBeNull();
      expect(() => savePreferredDevice('x')).not.toThrow();
      expect(() => savePreferredDevice(null)).not.toThrow();
      expect(loadDeviceMeta('x')).toBeNull();
      expect(() =>
        saveDeviceMeta('x', { name: 'n', platform: null, version: null, seenAt: 0 }),
      ).not.toThrow();
    } finally {
      Object.defineProperty(window, 'localStorage', orig);
    }
  });
});
