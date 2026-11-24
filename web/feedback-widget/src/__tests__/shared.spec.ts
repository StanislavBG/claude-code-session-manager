import { afterEach, describe, expect, it } from 'vitest';
import { PANEL_COLUMN, adoptInto, freeArea } from '../ui/shared';

describe('PANEL_COLUMN', () => {
  it('is the 412 px docked panel column', () => {
    expect(PANEL_COLUMN).toBe(412);
  });
});

describe('freeArea', () => {
  it('is the whole viewport in flow annotate, whatever the panel side', () => {
    expect(freeArea(1280, 'annotate')).toEqual({ x0: 0, x1: 1280 });
    expect(freeArea(1280, 'annotate', 'left')).toEqual({ x0: 0, x1: 1280 });
    expect(freeArea(1024, 'annotate', 'right')).toEqual({ x0: 0, x1: 1024 });
  });

  it('excludes the panel column on the right when docked right (the default side)', () => {
    expect(freeArea(1280, 'docked', 'right')).toEqual({ x0: 0, x1: 868 });
    expect(freeArea(1280, 'docked')).toEqual({ x0: 0, x1: 868 });
    expect(freeArea(1024, 'docked', 'right')).toEqual({ x0: 0, x1: 612 });
  });

  it('excludes the panel column on the left when docked left', () => {
    expect(freeArea(1280, 'docked', 'left')).toEqual({ x0: 412, x1: 1280 });
    expect(freeArea(1024, 'docked', 'left')).toEqual({ x0: 412, x1: 1024 });
  });
});

describe('adoptInto', () => {
  const canConstruct = typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in Document.prototype;
  let host: HTMLElement | null = null;
  afterEach(() => {
    host?.remove();
    host = null;
  });

  it.runIf(canConstruct)('adopts each sheet on the shadow root once', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const el = document.createElement('span');
    shadow.appendChild(el);
    const a = new CSSStyleSheet();
    const b = new CSSStyleSheet();
    adoptInto(el, a);
    adoptInto(el, [a, b, null]);
    adoptInto(el, b);
    expect(shadow.adoptedStyleSheets).toEqual([a, b]);
  });

  it('ignores a null root and null sheets', () => {
    expect(() => adoptInto(null, null)).not.toThrow();
    expect(() => adoptInto(document.createElement('div'), null)).not.toThrow();
  });
});
