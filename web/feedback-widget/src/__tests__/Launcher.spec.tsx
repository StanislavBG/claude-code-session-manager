// Launcher — handoff README §5.1 (corner default, edge, mini, hidden + coach), §5.7 anchors,
// §4 ARIA, §2 visibility, §8 icon.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import {
  Launcher,
  LAUNCHER_ARIA_LABEL,
  BUBBLE_PATHS,
  launcherCss,
  launcherSheet,
  anchorClass,
  ANCHOR_DECLS,
  COACH_SEEN_KEY,
  COACH_MS,
  CHECK_PATH,
  type LauncherVariant,
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
  localStorage.clear();
  vi.useRealTimers();
});

function mount(
  state: State,
  props: { capturing?: boolean; onOpen?: () => void; variant?: LauncherVariant } = {},
) {
  act(() => {
    render(
      <Launcher
        state={state}
        variant={props.variant}
        capturing={props.capturing}
        onOpen={props.onOpen ?? (() => {})}
      />,
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
    const rule = css.match(/\.fw-launcher--corner\{[^}]*\}/)![0];
    expect(css).toMatch(/\.fw-launcher\{[^}]*position:fixed;z-index:40/);
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
      expect(decl === 'position:fixed' || decl === 'z-index:40' ? css : rule).toContain(decl);
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
    expect(css).toMatch(/\.fw-launcher--corner \.fw-launcher-label\{[^}]*font-weight:600;font-size:14px;padding-left:10px/);
    expect(css).toMatch(
      /\.fw-launcher--corner \.fw-launcher-key\{[^}]*font-weight:500;font-size:11px;padding:2px 6px;border-radius:5px;background:rgba\(245,240,230,\.12\);color:#f4b942;margin-left:8px/,
    );
    expect(css).toContain("'JetBrains Mono'");
    expect(css).toContain("'Inter Tight'");
  });
});

function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(^|\\n|,)${esc}(,[^{]*)?\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[3];
}

describe('variant default', () => {
  it('renders the corner launcher when no variant is given', () => {
    const b = mount(initialState())!;
    expect(b.classList.contains('fw-launcher--corner')).toBe(true);
    expect(b.querySelector('svg')!.getAttribute('width')).toBe('22');
  });

  it('FeedbackConfig.launcher defaults to corner and accepts the three others', async () => {
    const { resolveConfig } = await import('../host');
    const w = window as unknown as { FeedbackConfig?: unknown };
    try {
      w.FeedbackConfig = { project: 'p' };
      expect(resolveConfig(null).launcher).toBe('corner');
      w.FeedbackConfig = { project: 'p', launcher: 'bogus' };
      expect(resolveConfig(null).launcher).toBe('corner');
      for (const v of ['edge', 'mini', 'hidden'] as const) {
        w.FeedbackConfig = { project: 'p', launcher: v };
        expect(resolveConfig(null).launcher).toBe(v);
      }
    } finally {
      delete w.FeedbackConfig;
    }
  });
});

describe('edge launcher — §5.1 Edge', () => {
  const css = launcherCss();
  it('renders an 18 px icon, a vertical Feedback label and the ⇧F key', () => {
    const b = mount(initialState(), { variant: 'edge' })!;
    expect(b.className).toBe('fw-launcher fw-launcher--edge');
    expect(b.getAttribute('aria-label')).toBe(LAUNCHER_ARIA_LABEL);
    const svg = b.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('18');
    expect(b.querySelector('.fw-launcher-label')!.textContent).toBe('Feedback');
    expect(b.querySelector('.fw-launcher-key')!.textContent).toBe('⇧F');
    expect(b.querySelector('.fw-launcher-slot')).toBeNull();
    expect(shadow.querySelector('[style]')).toBeNull();
  });

  it('sits on the right edge, vertically centred, sized and shadowed per spec', () => {
    const r = rule(css, '.fw-launcher--edge');
    for (const d of [
      'right:-6px',
      'top:50%',
      'transform:translateY(-50%)',
      'width:46px',
      'flex-direction:column',
      'gap:10px',
      'padding:14px 6px 14px 0',
      'border-radius:10px 0 0 10px',
      'background:#1a1612',
      'color:#f5f0e6',
      'box-shadow:-10px 10px 30px -12px rgba(26,22,18,.6)',
      'transform 250ms cubic-bezier(.2,.8,.2,1)',
    ]) {
      expect(r).toContain(d);
    }
  });

  it('slides out 6 px on hover and fades the key in', () => {
    expect(rule(css, '.fw-launcher--edge:hover')).toBe('transform:translateY(-50%) translateX(-6px)');
    const label = rule(css, '.fw-launcher--edge .fw-launcher-label');
    expect(label).toContain('writing-mode:vertical-rl;transform:rotate(180deg)');
    expect(label).toContain('font-weight:600;font-size:13px;letter-spacing:.02em');
    const key = rule(css, '.fw-launcher--edge .fw-launcher-key');
    expect(key).toContain('font-weight:500;font-size:10px;color:#f4b942');
    expect(key).toContain('opacity:0');
    expect(rule(css, '.fw-launcher--edge:hover .fw-launcher-key')).toBe('opacity:1');
    expect(rule(css, '.fw-launcher--edge .fw-launcher-icon')).toBe('width:18px;height:18px');
  });
});

describe('mini launcher — §5.1 Mini', () => {
  const css = launcherCss();
  it('renders an 18 px icon and the hover label slot', () => {
    const b = mount(initialState(), { variant: 'mini' })!;
    expect(b.className).toBe('fw-launcher fw-launcher--mini');
    expect(b.querySelector('svg')!.getAttribute('width')).toBe('18');
    expect(b.querySelector('.fw-launcher-slot .fw-launcher-label')!.textContent).toBe('Feedback');
    expect(b.querySelector('.fw-launcher-slot .fw-launcher-key')!.textContent).toBe('⇧F');
  });

  it('sits bottom-left, light pill, sized and shadowed per spec', () => {
    const r = rule(css, '.fw-launcher--mini');
    for (const d of [
      'left:20px',
      'bottom:20px',
      'height:38px',
      'min-width:38px',
      'padding:0 9px',
      'border-radius:19px',
      'border:1px solid #d4ccb8',
      'background:#f5f0e6',
      'color:#1a1612',
      'box-shadow:0 8px 22px -10px rgba(26,22,18,.45)',
    ]) {
      expect(r).toContain(d);
    }
  });

  it('styles the hover label and the light key chip', () => {
    expect(rule(css, '.fw-launcher--mini .fw-launcher-label')).toContain('font-weight:600;font-size:13px');
    expect(rule(css, '.fw-launcher--mini .fw-launcher-key')).toContain(
      'font-weight:500;font-size:10.5px;padding:2px 5px;border-radius:4px;background:#e3dcc8;color:#5d5648',
    );
    // Shares the corner's hover slot (max-width 0→150).
    expect(css).toMatch(/\.fw-launcher:hover \.fw-launcher-slot[^{]*\{max-width:150px;opacity:1\}/);
  });

  it('pings green with paper text', () => {
    expect(rule(css, '.fw-launcher--mini.fw-launcher--ping')).toBe('background:#2e5a3e;color:#f5f0e6');
  });
});

describe('ping across variants', () => {
  const pinged = { ...initialState(), ping: true } as State;
  it.each(['corner', 'edge', 'mini'] as const)('%s shows the 2.2-stroke check while pinging', (variant) => {
    const b = mount(pinged, { variant })!;
    expect(b.classList.contains('fw-launcher--ping')).toBe(true);
    const svg = b.querySelector('svg')!;
    expect(svg.getAttribute('stroke-width')).toBe('2.2');
    expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([CHECK_PATH]);
  });
  it('ping background is green', () => {
    expect(rule(launcherCss(), '.fw-launcher--ping')).toBe('background:#2e5a3e');
  });
});

describe('hidden launcher + coach toast — §5.1 Hidden', () => {
  const coach = () => shadow.querySelector<HTMLDivElement>('.fw-coach');

  it('renders no launcher button, only the coach', () => {
    mount(initialState(), { variant: 'hidden' });
    expect(shadow.querySelector('.fw-launcher')).toBeNull();
    const c = coach()!;
    expect(c.textContent).toBe('Spotted a problem? Press⇧Fto send feedbackGot it');
    expect([...c.querySelectorAll('.fw-coach-cap')].map((k) => k.textContent)).toEqual(['⇧', 'F']);
    expect(c.querySelector('button.fw-coach-ok')!.textContent).toBe('Got it');
    expect(shadow.querySelector('[style]')).toBeNull();
  });

  it('shows once per browser (localStorage fw:coachSeen)', () => {
    expect(COACH_SEEN_KEY).toBe('fw:coachSeen');
    mount(initialState(), { variant: 'hidden' });
    expect(coach()).not.toBeNull();
    expect(localStorage.getItem('fw:coachSeen')).not.toBeNull();
    // A fresh page load (remount) never shows it again.
    act(() => render(null, shadow as unknown as Element));
    mount(initialState(), { variant: 'hidden' });
    expect(coach()).toBeNull();
  });

  it('does not show when already seen', () => {
    localStorage.setItem('fw:coachSeen', '1');
    mount(initialState(), { variant: 'hidden' });
    expect(coach()).toBeNull();
  });

  it('auto-hides after 9 s', () => {
    vi.useFakeTimers();
    expect(COACH_MS).toBe(9000);
    mount(initialState(), { variant: 'hidden' });
    act(() => {
      vi.advanceTimersByTime(8999);
    });
    expect(coach()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(coach()).toBeNull();
  });

  it("'Got it' dismisses it", () => {
    mount(initialState(), { variant: 'hidden' });
    act(() => coach()!.querySelector<HTMLButtonElement>('.fw-coach-ok')!.click());
    expect(coach()).toBeNull();
  });

  it('does not use up the hint while it is not visible', () => {
    mount(initialState(), { variant: 'hidden', capturing: true });
    expect(coach()).toBeNull();
    expect(localStorage.getItem('fw:coachSeen')).toBeNull();
    mount(run({ type: 'open' }), { variant: 'hidden' });
    expect(coach()).toBeNull();
    expect(localStorage.getItem('fw:coachSeen')).toBeNull();
    mount(initialState(), { variant: 'hidden' });
    expect(coach()).not.toBeNull();
    expect(localStorage.getItem('fw:coachSeen')).not.toBeNull();
  });

  it('is hidden while capturing or outside idle', () => {
    mount(initialState(), { variant: 'hidden', capturing: true });
    expect(coach()).toBeNull();
    mount(run({ type: 'open' }), { variant: 'hidden' });
    expect(coach()).toBeNull();
  });

  it('styles the toast, key caps and Got it per spec', () => {
    const css = launcherCss();
    const r = rule(css, '.fw-coach');
    for (const d of [
      'position:fixed',
      'z-index:40',
      'right:20px',
      'bottom:20px',
      'gap:14px',
      'padding:10px 10px 10px 16px',
      'border-radius:12px',
      'background:#1a1612',
      'color:#f5f0e6',
      'box-shadow:0 14px 34px -12px rgba(26,22,18,.6)',
      'pointer-events:auto',
      'font-weight:500;font-size:13.5px',
    ]) {
      expect(r).toContain(d);
    }
    const cap = rule(css, '.fw-coach-cap');
    for (const d of [
      'min-width:22px',
      'height:22px',
      'border-radius:5px',
      'background:#f5f0e6',
      'color:#1a1612',
      'font-weight:600;font-size:11px',
      'box-shadow:inset 0 -2px 0 #c9bfa9',
    ]) {
      expect(cap).toContain(d);
    }
    expect(cap).toContain("'JetBrains Mono'");
    const ok = rule(css, '.fw-coach-ok');
    for (const d of ['height:30px', 'padding:0 12px', 'border-radius:8px', 'background:rgba(245,240,230,.12)', 'font-weight:600;font-size:12.5px']) {
      expect(ok).toContain(d);
    }
    expect(rule(css, '.fw-coach-ok:hover')).toBe('background:rgba(245,240,230,.2)');
  });
});

describe('toast / ping anchor — §5.7 Position', () => {
  const css = launcherCss();
  it.each([
    ['corner', 'right:24px;bottom:90px'],
    ['edge', 'right:54px;top:50%;transform:translateY(-50%)'],
    ['mini', 'left:20px;bottom:70px'],
    ['hidden', 'right:20px;bottom:20px'],
  ] as const)('%s → %s', (variant, decls) => {
    expect(ANCHOR_DECLS[variant]).toBe(decls);
    expect(anchorClass(variant)).toBe(`fw-anchor fw-anchor--${variant}`);
    expect(rule(css, `.fw-anchor--${variant}`)).toBe(decls);
  });
  it('anchors are fixed-position', () => {
    expect(rule(css, '.fw-anchor')).toBe('position:fixed');
  });
});
