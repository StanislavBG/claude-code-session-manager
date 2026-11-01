import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');
const { chooseOzonePlatform } = require('../ozonePlatform.cjs');

describe('chooseOzonePlatform', () => {
  it('override x11/wayland wins', () => {
    expect(chooseOzonePlatform({ SM_OZONE_PLATFORM: 'x11' })).toBe('x11');
    expect(chooseOzonePlatform({ SM_OZONE_PLATFORM: 'wayland', XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' })).toBe('wayland');
    expect(chooseOzonePlatform({ SM_OZONE_PLATFORM: ' WAYLAND ' })).toBe('wayland');
  });
  it('auto or unset falls through to default rule', () => {
    expect(chooseOzonePlatform({ SM_OZONE_PLATFORM: 'auto', XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' })).toBe('x11');
    expect(chooseOzonePlatform({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0' })).toBe('x11');
    expect(chooseOzonePlatform({ SM_OZONE_PLATFORM: 'bogus', XDG_SESSION_TYPE: 'x11' })).toBeNull();
  });
  it('wayland without DISPLAY returns null', () => {
    expect(chooseOzonePlatform({ XDG_SESSION_TYPE: 'wayland' })).toBeNull();
    expect(chooseOzonePlatform({ XDG_SESSION_TYPE: 'wayland', DISPLAY: '' })).toBeNull();
  });
  it('non-wayland session returns null', () => {
    expect(chooseOzonePlatform({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' })).toBeNull();
    expect(chooseOzonePlatform({})).toBeNull();
    expect(chooseOzonePlatform()).toBeNull();
  });

  it('index.cjs no longer sets the switch (too late; the launcher owns it)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'index.cjs'), 'utf8');
    expect(src).not.toContain("appendSwitch('ozone-platform'");
    expect(src).not.toContain('ozonePlatform.cjs');
  });
});
