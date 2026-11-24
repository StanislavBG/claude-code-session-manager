// Discard dialog — handoff README §5.8, §2 (confirm row), §3 (Esc priority), §4 (ARIA).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { useReducer } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { DiscardDialog, discardBody, discardCss, DISCARD_TITLE } from '../ui/DiscardDialog';
import { initialState, reduce, type Event, type State } from '../ui/machine';

let host: HTMLDivElement;
let shadow: ShadowRoot;

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

function run(...events: Event[]): State {
  return events.reduce(reduce, initialState());
}

/** Mounts the dialog wired to the real machine; returns a getter for the live state. */
function mountLive(start: State) {
  let current = start;
  function Harness() {
    const [s, dispatch] = useReducer(reduce, start);
    current = s;
    return <DiscardDialog state={s} dispatch={dispatch} />;
  }
  act(() => render(<Harness />, shadow as unknown as Element));
  return () => current;
}

const dialog = () => shadow.querySelector<HTMLElement>('[role="dialog"]');
const buttons = () => Array.from(shadow.querySelectorAll<HTMLButtonElement>('button'));
const button = (label: string) => buttons().find((b) => b.textContent === label)!;

describe('discardBody', () => {
  it('names the marks and what was written when text exists', () => {
    expect(discardBody(2, true)).toBe('You will lose 2 marks and what you have written.');
  });
  it('drops the second clause when no text was entered', () => {
    expect(discardBody(3, false)).toBe('You will lose 3 marks.');
  });
  it('singularises one mark', () => {
    expect(discardBody(1, false)).toBe('You will lose 1 mark.');
  });
});

describe('open condition', () => {
  it('is not shown on close with no marks and no text — the widget goes idle', () => {
    const s = run({ type: 'open' }, { type: 'closeRequest' });
    expect(s.mode).toBe('idle');
    mountLive(s);
    expect(dialog()).toBeNull();
  });

  it('is not shown while open with content but no close request', () => {
    mountLive(run({ type: 'open' }, { type: 'addMark', id: 'm1' }));
    expect(dialog()).toBeNull();
  });

  it('is shown on close when marks exist', () => {
    mountLive(run({ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'closeRequest' }));
    expect(dialog()).not.toBeNull();
  });

  it('is shown on close when only text exists', () => {
    mountLive(run({ type: 'open' }, { type: 'draft', body: 'broken' }, { type: 'closeRequest' }));
    expect(dialog()).not.toBeNull();
  });

  it('whitespace-only text does not count', () => {
    const s = run({ type: 'open' }, { type: 'draft', title: '   ' }, { type: 'closeRequest' });
    mountLive(s);
    expect(dialog()).toBeNull();
  });
});

describe('content and ARIA', () => {
  it('renders the title, the full body and both buttons with dialog ARIA', () => {
    mountLive(
      run(
        { type: 'open' },
        { type: 'addMark', id: 'm1' },
        { type: 'addMark', id: 'm2' },
        { type: 'draft', title: 'Button broken' },
        { type: 'closeRequest' },
      ),
    );
    const d = dialog()!;
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(shadow.querySelector('.fw-discard-title')!.textContent).toBe(DISCARD_TITLE);
    expect(DISCARD_TITLE).toBe('Discard this feedback?');
    expect(shadow.querySelector('.fw-discard-body')!.textContent).toBe(
      'You will lose 2 marks and what you have written.',
    );
    expect(buttons().map((b) => b.textContent)).toEqual(['Keep editing', 'Discard']);
    const labelId = d.getAttribute('aria-labelledby');
    expect(labelId && shadow.getElementById(labelId)?.textContent).toBe(DISCARD_TITLE);
  });

  it('drops the second clause when only marks exist', () => {
    mountLive(run({ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'addMark', id: 'm2' }, { type: 'closeRequest' }));
    expect(shadow.querySelector('.fw-discard-body')!.textContent).toBe('You will lose 2 marks.');
  });

  it('focuses Keep editing on open', () => {
    mountLive(run({ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'closeRequest' }));
    expect(shadow.activeElement).toBe(button('Keep editing'));
  });
});

describe('buttons and Esc', () => {
  const confirming = () =>
    run({ type: 'open' }, { type: 'addMark', id: 'm1' }, { type: 'draft', title: 'Hi there' }, { type: 'closeRequest' });

  it('Keep editing closes the dialog and keeps marks and draft', () => {
    const get = mountLive(confirming());
    act(() => button('Keep editing').click());
    expect(dialog()).toBeNull();
    expect(get().mode).toBe('annotate');
    expect(get().marks).toHaveLength(1);
    expect(get().draft.title).toBe('Hi there');
  });

  it('Esc closes the dialog and keeps the session', () => {
    const get = mountLive(confirming());
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog()).toBeNull();
    expect(get().mode).toBe('annotate');
    expect(get().marks).toHaveLength(1);
  });

  it('Esc does not bubble past the dialog (no second close request)', () => {
    mountLive(confirming());
    let outer = 0;
    host.addEventListener('keydown', () => outer++);
    act(() => {
      button('Keep editing').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    });
    expect(outer).toBe(0);
  });

  it('Discard resets everything to idle', () => {
    const get = mountLive(confirming());
    act(() => button('Discard').click());
    expect(dialog()).toBeNull();
    const s = get();
    expect(s.mode).toBe('idle');
    expect(s.confirm).toBe(false);
    expect(s.marks).toEqual([]);
    expect(s.draft).toEqual({ title: '', body: '' });
  });
});

describe('styles (§5.8)', () => {
  const css = discardCss();
  it('scrim covers the viewport at rgba(26,22,18,.38)', () => {
    expect(css).toMatch(/\.fw-discard-scrim\{[^}]*position:fixed;inset:0[^}]*background:rgba\(26,22,18,\.38\)/);
  });
  it('card is 360 px, max calc(100% - 32px), with the handoff box styles', () => {
    expect(css).toMatch(/\.fw-discard-card\{[^}]*width:360px;max-width:calc\(100% - 32px\)/);
    expect(css).toContain('padding:22px 22px 18px');
    expect(css).toContain('border-radius:14px');
    expect(css).toContain('box-shadow:0 24px 60px -18px rgba(26,22,18,.6)');
  });
  it('Discard is accent on on-accent; buttons are h38 r9 600 13.5', () => {
    expect(css).toMatch(/\.fw-discard-go\{[^}]*background:#a83818;color:#fff8ef/);
    expect(css).toMatch(/\.fw-discard-btn\{[^}]*height:38px;padding:0 14px;border-radius:9px;[^}]*font-weight:600;font-size:13\.5px/);
  });
});
