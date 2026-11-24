// Corner launcher — handoff README §5.1 "Corner (default)", §4 ARIA, §2 visibility, §8 icon.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import {
  Launcher,
  LAUNCHER_ARIA_LABEL,
  BUBBLE_PATHS,
  launcherCss,
  launcherSheet,
} from '../ui/Launcher';
import { initialState, reduce, type Event, type State } from '../ui/machine';

let host: HTMLDivElement;
let shadow: ShadowRoot;

// jsdom has constructable CSSStyleSheet but may lack ShadowRoot.adoptedStyleSheets.
if (!('adoptedStyleSheets' in ShadowRoot.prototype)) {
  const sheets = new WeakMap<ShadowRoot, CSSStyleSheet[]>();
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get(this: ShadowRoot) {
      return sheets.get(this) ?? [];
    },
    set(this: ShadowRoot, v: CSSStyleSheet[]) {
      sheets.set(this, v);
    },
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
});

afterEach(() => {
  act(() => render(null, shadow as unknown as Element));
  host.remove();
});

function mount(state: State, props: { capturing?: boolean; onOpen?: () => void } = {}) {
  act(() => {
    render(
      <Launcher state={state} capturing={props.capturing} onOpen={props.onOpen ?? (() => {})} />,
      shadow as unknown as Element,
    );
  });
  return shadow.querySelector<HTMLButtonElement>('button.fw-launcher');
}

function run(...events: Event[]): State {
  return events.reduce(reduce, initialState());
}

describe('Launcher visibility per mode', () => {
  it('renders in idle', () => {
    expect(mount(initialState())).not.toBeNull();
  });

  it.each([
    ['annotate', run({ type: 'open' })],
    ['review', run({ type: 'open' }, { type: 'describe' })],
    ['sending', run({ type: 'open' }, { type: 'draft', title: 'Broken' }, { type: 'describe' }, { type: 'send' })],
    [
      'error',
      run({ type: 'open' }, { type: 'draft', title: 'Broken' }, { type: 'describe' }, { type: 'send' }, { type: 'sendFail' }),
    ],
    [
      'sent',
      run({ type: 'open' }, { type: 'draft', title: 'Broken' }, { type: 'describe' }, { type: 'send' }, { type: 'sendOk', id: 'r1' }),
    ],
  ])('is not rendered in %s', (mode, s) => {
    expect(s.mode).toBe(mode);
    expect(mount(s)).toBeNull();
  });

  it('stays rendered during folding (the fold target, §2)', () => {
    const s = [{ type: 'open' }, { type: 'draft', title: 'Broken' }, { type: 'describe' }, { type: 'send' }, { type: 'sendOk' }].reduce(
      (acc, e) => reduce(acc, e as Event),
      initialState({ success: 'fold' }),
    );
    expect(s.folding).toBe(true);
    expect(mount(s)).not.toBeNull();
  });

  it('is hidden during screenshot capture even in idle', () => {
    expect(mount(initialState(), { capturing: true })).toBeNull();
    expect(mount(initialState(), { capturing: false })).not.toBeNull();
  });
});

describe('Launcher markup', () => {
  it("has aria-label 'Send feedback (Shift+F)'", () => {
    const b = mount(initialState())!;
    expect(LAUNCHER_ARIA_LABEL).toBe('Send feedback (Shift+F)');
    expect(b.getAttribute('aria-label')).toBe('Send feedback (Shift+F)');
    expect(b.getAttribute('type')).toBe('button');
  });

  it('carries the 22 px chat-bubble icon (§8) and the label slot with Feedback + ⇧F', () => {
    const b = mount(initialState())!;
    const svg = b.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('22');
    expect(svg.getAttribute('height')).toBe('22');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('stroke-width')).toBe('1.8');
    const ds = [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(ds).toEqual([...BUBBLE_PATHS]);
    expect(BUBBLE_PATHS[1]).toBe('M8 10h8M8 13.2h5');
    expect(b.querySelector('.fw-launcher-label')!.textContent).toBe('Feedback');
    expect(b.querySelector('.fw-launcher-key')!.textContent).toBe('⇧F');
    // Never a style attribute (strict CSP).
    expect(shadow.querySelector('[style]')).toBeNull();
  });

  it('adopts its constructed sheet on the shadow root once', () => {
    mount(initialState());
    mount(initialState());
    expect(shadow.adoptedStyleSheets.filter((s) => s === launcherSheet())).toHaveLength(1);
  });
});

describe('Launcher click', () => {
  it('calls onOpen once per click', () => {
    const onOpen = vi.fn();
    const b = mount(initialState(), { onOpen })!;
    act(() => b.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('launcherCss — §5.1 corner spec', () => {
  const css = launcherCss();
  it('positions and sizes the corner bubble', () => {
    for (const decl of [
      'position:fixed',
      'right:24px',
      'bottom:24px',
      'height:52px',
      'min-width:52px',
      'padding:0 15px',
      'border-radius:26px',
      'background:#1a1612',
      'color:#f5f0e6',
      'z-index:40',
      'box-shadow:0 14px 34px -10px rgba(26,22,18,.65), inset 0 0 0 1px rgba(245,240,230,.08)',
    ]) {
      expect(css).toContain(decl);
    }
  });

  it('opens the label slot on hover: max-width 0→150 px / 350 ms, opacity / 200 ms', () => {
    expect(css).toMatch(/\.fw-launcher-slot\{[^}]*max-width:0[;}]/);
    expect(css).toMatch(/\.fw-launcher-slot\{[^}]*opacity:0[;}]/);
    expect(css).toContain('max-width 350ms cubic-bezier(.2,.8,.2,1)');
    expect(css).toContain('opacity 200ms cubic-bezier(.2,.8,.2,1)');
    expect(css).toMatch(/\.fw-launcher:hover \.fw-launcher-slot[^{]*\{[^}]*max-width:150px;opacity:1/);
  });

  it('styles the label and amber key chip', () => {
    expect(css).toMatch(/\.fw-launcher-label\{[^}]*font-weight:600;font-size:14px;padding-left:10px/);
    expect(css).toMatch(
      /\.fw-launcher-key\{[^}]*font-weight:500;font-size:11px;padding:2px 6px;border-radius:5px;background:rgba\(245,240,230,\.12\);color:#f4b942;margin-left:8px/,
    );
    expect(css).toContain("'JetBrains Mono'");
    expect(css).toContain("'Inter Tight'");
  });
});
