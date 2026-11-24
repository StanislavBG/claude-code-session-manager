// Panel "Marks on screenshot" + "Attached automatically" sections — handoff README §5.6.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import type { ConsoleEntry, NetworkEntry } from '../buffers';
import { buildReport, type ReportState } from '../report';
import { number, type Mark } from '../ui/marks';
import {
  CONSOLE_OFF,
  MARKS_EMPTY,
  NETWORK_OFF,
  NOTE_PLACEHOLDER,
  PanelContext,
  kindLabel,
  marksCount,
  panelContextCss,
  screenshotLabel,
  unnumberedSummary,
  type PanelContextProps,
} from '../ui/PanelContext';

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

let host: HTMLDivElement;
let shadow: ShadowRoot;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
});

afterEach(() => {
  act(() => render(null, shadow as unknown as Element));
  host.remove();
});

const RUST = '#a83818' as const;

const MARKS: Mark[] = number([
  { id: 'p', kind: 'pin', x: 10, y: 40, color: RUST, comment: 'Price wrong' },
  { id: 'b', kind: 'box', x: 50, y: 50, w: 40, h: 30, color: '#f4b942' },
  { id: 'e', kind: 'element', x: 100, y: 100, w: 77, h: 34, color: RUST, selector: 'button.book' },
  { id: 'd', kind: 'draw', color: RUST, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 2 }] },
  { id: 'a', kind: 'arrow', color: RUST, x1: 0, y1: 0, x2: 40, y2: 40 },
  { id: 't', kind: 'text', color: RUST, x: 20, y: 20, text: 'here' },
]);

const CONSOLE: ConsoleEntry[] = [
  {
    level: 'error',
    message: "TypeError: Cannot read properties of undefined (reading 'nightlyRate')",
    stack: '',
    source: 'listing-card.js:88:12',
    timestamp: '2026-11-23T10:00:00.000Z',
    count: 1,
  },
  { level: 'error', message: 'HoldError: hold_failed', stack: '', source: 'checkout.js:214:3', timestamp: '2026-11-23T10:00:01.000Z', count: 3 },
];

const NETWORK: NetworkEntry[] = [
  { method: 'POST', url: '/api/bookings/hold', status: 502, durationMs: 1240, timestamp: '2026-11-23T10:00:02.000Z' },
];

const $ = <T extends Element = HTMLElement>(sel: string) => shadow.querySelector<T>(sel);
const $$ = (sel: string) => Array.from(shadow.querySelectorAll<HTMLElement>(sel));
const text = (sel: string) => $(sel)?.textContent ?? null;
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

interface Log {
  notes: [string, string][];
  removed: string[];
  hovered: (string | null)[];
  switched: [string, boolean][];
}

/** Stateful harness: owns marks + switches the way the widget root will. */
function mount(init: Partial<{ marks: Mark[]; console: ConsoleEntry[]; network: NetworkEntry[] }> = {}) {
  const log: Log = { notes: [], removed: [], hovered: [], switched: [] };
  const live: { switches: { console: boolean; network: boolean }; marks: readonly Mark[] } = {
    switches: { console: true, network: true },
    marks: init.marks ?? MARKS,
  };
  function Harness(over: Partial<PanelContextProps>) {
    const [marks, setMarks] = useState<readonly Mark[]>(init.marks ?? MARKS);
    const [switches, setSwitches] = useState({ console: true, network: true });
    live.switches = switches;
    live.marks = marks;
    return (
      <PanelContext
        marks={marks}
        onNote={(id, note) => {
          log.notes.push([id, note]);
          setMarks(marks.map((m) => (m.id === id ? ({ ...m, comment: note } as Mark) : m)));
        }}
        onRemove={(id) => {
          log.removed.push(id);
          setMarks(number(marks.filter((m) => m.id !== id)));
        }}
        onHover={(id) => log.hovered.push(id)}
        screenshot={{ width: 1280, height: 800 }}
        pageUrl="https://lumenstays.com/stays/lisbon"
        console={init.console ?? CONSOLE}
        network={init.network ?? NETWORK}
        switches={switches}
        onSwitch={(name, on) => {
          log.switched.push([name, on]);
          setSwitches({ ...switches, [name]: on });
        }}
        {...over}
      />
    );
  }
  act(() => render(<Harness />, shadow as unknown as Element));
  return { log, live };
}

function reportState(switches: { console: boolean; network: boolean }): ReportState {
  return {
    config: { boxId: 'ABCDEFGH' },
    draft: { type: 'bug', title: 'Broken', details: '' },
    marks: [],
    page: { url: 'https://x.test/', title: 'x', viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 } },
    capture: { capturedAt: new Date('2026-11-23T10:00:00Z'), width: 1280, height: 800, scale: 1 },
    buffers: { console: CONSOLE, network: NETWORK },
    switches,
    reporter: null,
    widgetVersion: '0.1.0',
  };
}

describe('pure helpers', () => {
  it('counts marks and summarises unnumbered ones', () => {
    expect(marksCount([])).toBe('none yet');
    expect(marksCount(MARKS.slice(0, 1))).toBe('1 mark');
    expect(marksCount(MARKS.slice(0, 3))).toBe('3 marks');
    expect(unnumberedSummary(MARKS)).toBe('+ 1 drawing · 1 arrow · 1 label');
    expect(unnumberedSummary(MARKS.slice(0, 3))).toBe('');
    expect(screenshotLabel(1280, 800, 6)).toBe('1280 × 800 · 6 marks');
    expect(kindLabel(MARKS[0]!)).toBe('Pin');
    expect(kindLabel(MARKS[1]!)).toBe('Box');
    expect(kindLabel(MARKS[2]!)).toBe('Element · button.book');
  });

  it('styles the lists, the switch and the rows per §5.6', () => {
    const css = panelContextCss();
    expect(css).toContain('.fw-pc-list{');
    expect(css).toMatch(/\.fw-pc-list\{[^}]*background:#1a1612/);
    expect(css).toMatch(/\.fw-pc-msg\{color:#f4b942;overflow-wrap:anywhere\}/);
    expect(css).toMatch(/\.fw-pc-src\{color:#c9bfa9\}/);
    expect(css).toMatch(/\.fw-pc-switch\{[^}]*width:30px;height:18px;border-radius:9px;background:#c9bfa9/);
    expect(css).toMatch(/\.fw-pc-switch\[aria-checked="true"\]\{background:#2e5a3e\}/);
    expect(css).toMatch(/\.fw-pc-knob\{[^}]*width:14px;height:14px/);
    expect(css).toContain('translateX(12px)');
    expect(css).toMatch(/\.fw-pc-row\{display:grid;grid-template-columns:24px 1fr 26px;gap:10px/);
    expect(css).toMatch(/\.fw-pc-arow\{display:grid;grid-template-columns:78px minmax\(0,1fr\) auto/);
    expect(css).toMatch(/\.fw-pc-empty\{border:1px dashed #c9bfa9;border-radius:8px/);
  });
});

describe('Marks on screenshot', () => {
  it('shows "none yet" and the dashed empty state with no marks', () => {
    mount({ marks: [] });
    expect(text('[data-part="marks-count"]')).toBe('none yet');
    expect(text('[data-part="marks-empty"]')).toBe(MARKS_EMPTY);
    expect($$('.fw-pc-row')).toHaveLength(0);
    expect(text('[data-row="screenshot"] [data-part="value"]')).toBe('1280 × 800 · 0 marks');
  });

  it('renders one row per numbered mark plus the unnumbered summary line', () => {
    mount();
    expect(text('[data-part="marks-count"]')).toBe('6 marks');
    expect($('[data-part="marks-empty"]')).toBeNull();
    const rows = $$('.fw-pc-row');
    expect(rows.map((r) => r.dataset.mark)).toEqual(['p', 'b', 'e']);
    expect(rows.map((r) => r.querySelector('[data-part="badge"]')!.textContent)).toEqual(['1', '2', '3']);
    expect(rows.map((r) => r.querySelector('[data-part="kind"]')!.textContent)).toEqual(['Pin', 'Box', 'Element · button.book']);
    const badge = rows[1]!.querySelector<HTMLElement>('[data-part="badge"]')!;
    expect(badge.style.color).toBeTruthy();
    expect(badge.getAttribute('style')).not.toBeNull(); // CSSOM-written, not authored
    const notes = rows.map((r) => r.querySelector<HTMLInputElement>('[data-part="note"]')!);
    expect(notes.map((n) => n.placeholder)).toEqual([NOTE_PLACEHOLDER, NOTE_PLACEHOLDER, NOTE_PLACEHOLDER]);
    expect(notes[0]!.value).toBe('Price wrong');
    expect(text('[data-part="marks-extra"]')).toBe('+ 1 drawing · 1 arrow · 1 label');
  });

  it('edits a note through onNote', () => {
    const { log } = mount();
    const input = $$('.fw-pc-row')[1]!.querySelector<HTMLInputElement>('[data-part="note"]')!;
    act(() => {
      input.value = 'Overlaps the map';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(log.notes).toEqual([['b', 'Overlaps the map']]);
    expect($$('.fw-pc-row')[1]!.querySelector<HTMLInputElement>('[data-part="note"]')!.value).toBe('Overlaps the map');
  });

  it('highlights the mark while its row is hovered', () => {
    const { log } = mount();
    const row = $$('.fw-pc-row')[2]!;
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(log.hovered).toEqual(['e']);
    act(() => {
      row.dispatchEvent(new MouseEvent('mouseleave'));
    });
    expect(log.hovered).toEqual(['e', null]);
  });

  it('removes a mark with × and renumbers the rest', () => {
    const { log, live } = mount();
    click($$('.fw-pc-row')[0]!.querySelector('[data-part="remove"]'));
    expect(log.removed).toEqual(['p']);
    expect(log.hovered).toEqual([null]);
    expect(live.marks.map((m) => m.id)).toEqual(['b', 'e', 'd', 'a', 't']);
    const rows = $$('.fw-pc-row');
    expect(rows.map((r) => r.dataset.mark)).toEqual(['b', 'e']);
    expect(rows.map((r) => r.querySelector('[data-part="badge"]')!.textContent)).toEqual(['1', '2']);
    expect(text('[data-part="marks-count"]')).toBe('5 marks');
    expect(text('[data-row="screenshot"] [data-part="value"]')).toBe('1280 × 800 · 5 marks');
  });
});

describe('Attached automatically', () => {
  it('always lists the screenshot and page URL', () => {
    mount();
    expect(text('[data-row="screenshot"] .fw-pc-key')).toBe('Screenshot');
    expect(text('[data-row="screenshot"] [data-part="value"]')).toBe('1280 × 800 · 6 marks');
    expect(text('[data-row="screenshot"] .fw-pc-always')).toBe('ALWAYS');
    expect(text('[data-row="page"] [data-part="value"]')).toBe('https://lumenstays.com/stays/lisbon');
    expect(text('[data-row="page"] .fw-pc-always')).toBe('ALWAYS');
    // Neither always-row has a switch.
    expect($('[data-row="screenshot"] [role="switch"]')).toBeNull();
    expect($('[data-row="page"] [role="switch"]')).toBeNull();
  });

  it('shows console + network counts with switches on by default', () => {
    mount();
    expect(text('[data-row="console"] [data-part="value"]')).toBe('2 console errors');
    expect(text('[data-row="network"] [data-part="value"]')).toBe('1 failed request');
    const sw = $$('[role="switch"]');
    expect(sw.map((s) => s.dataset.switch)).toEqual(['console', 'network']);
    expect(sw.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true']);
  });

  it('view/hide expands and collapses the console list', () => {
    mount();
    const view = $<HTMLButtonElement>('[data-row="console"] [data-part="view"]')!;
    expect(view.textContent).toBe('view');
    expect(view.getAttribute('aria-expanded')).toBe('false');
    expect($('[data-row="console"] [data-part="list"]')).toBeNull();
    click(view);
    const list = $('[data-row="console"] [data-part="list"]')!;
    expect(list.classList.contains('fw-pc-list')).toBe(true);
    expect(Array.from(list.querySelectorAll('.fw-pc-msg')).map((e) => e.textContent)).toEqual([
      "TypeError: Cannot read properties of undefined (reading 'nightlyRate')",
      'HoldError: hold_failed ×3',
    ]);
    expect(Array.from(list.querySelectorAll('.fw-pc-src')).map((e) => e.textContent)).toEqual([
      'listing-card.js:88:12',
      'checkout.js:214:3',
    ]);
    expect(text('[data-row="console"] [data-part="view"]')).toBe('hide');
    click($('[data-row="console"] [data-part="view"]'));
    expect($('[data-row="console"] [data-part="list"]')).toBeNull();
    expect(text('[data-row="console"] [data-part="view"]')).toBe('view');
  });

  it('view/hide expands and collapses the network list', () => {
    mount();
    click($('[data-row="network"] [data-part="view"]'));
    const list = $('[data-row="network"] [data-part="list"]')!;
    expect(list.querySelector('.fw-pc-msg')!.textContent).toBe('POST /api/bookings/hold → 502');
    expect(list.querySelector('.fw-pc-src')!.textContent).toBe('1.24s');
    click($('[data-row="network"] [data-part="view"]'));
    expect($('[data-row="network"] [data-part="list"]')).toBeNull();
  });

  it('console switch off → "not sent" copy, no list, and report.console = null', () => {
    const { log, live } = mount();
    click($('[data-row="console"] [data-part="view"]'));
    click($('[data-switch="console"]'));
    expect(log.switched).toEqual([['console', false]]);
    expect($('[data-switch="console"]')!.getAttribute('aria-checked')).toBe('false');
    expect(text('[data-row="console"] [data-part="value"]')).toBe(CONSOLE_OFF);
    expect($('[data-row="console"] .fw-pc-val--off')).not.toBeNull();
    expect($('[data-row="console"] [data-part="view"]')).toBeNull();
    expect($('[data-row="console"] [data-part="list"]')).toBeNull();
    const report = buildReport(reportState(live.switches));
    expect(report.console).toBeNull();
    expect(report.network).toHaveLength(1);
    // Back on: sent again.
    click($('[data-switch="console"]'));
    expect($('[data-switch="console"]')!.getAttribute('aria-checked')).toBe('true');
    expect(text('[data-row="console"] [data-part="value"]')).toBe('2 console errors');
    expect(buildReport(reportState(live.switches)).console).toHaveLength(2);
  });

  it('network switch off → "not sent" copy and report.network = null', () => {
    const { log, live } = mount();
    click($('[data-switch="network"]'));
    expect(log.switched).toEqual([['network', false]]);
    expect($('[data-switch="network"]')!.getAttribute('aria-checked')).toBe('false');
    expect(text('[data-row="network"] [data-part="value"]')).toBe(NETWORK_OFF);
    expect($('[data-row="network"] [data-part="view"]')).toBeNull();
    const report = buildReport(reportState(live.switches));
    expect(report.network).toBeNull();
    expect(report.console).toHaveLength(2);
  });

  it('shows zero counts without a view link', () => {
    mount({ console: [], network: [] });
    expect(text('[data-row="console"] [data-part="value"]')).toBe('0 console errors');
    expect(text('[data-row="network"] [data-part="value"]')).toBe('0 failed requests');
    expect($('[data-part="view"]')).toBeNull();
  });

  it('disables every input while sending', () => {
    function Sending() {
      return (
        <PanelContext
          marks={MARKS}
          onNote={() => {}}
          onRemove={() => {}}
          screenshot={{ width: 1, height: 1 }}
          pageUrl="u"
          console={CONSOLE}
          network={NETWORK}
          switches={{ console: true, network: true }}
          onSwitch={() => {}}
          disabled
        />
      );
    }
    act(() => render(<Sending />, shadow as unknown as Element));
    const controls = $$('input, [role="switch"], [data-part="remove"]') as (HTMLInputElement | HTMLButtonElement)[];
    expect(controls.length).toBe(3 + 3 + 2);
    expect(controls.every((c) => c.disabled)).toBe(true);
  });
});
