import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '../ui/machine';
import { DEFAULT_MARK_COLOR, MARK_COLORS, arrowHead, drawPath, type Mark, type MarkColor } from '../ui/marks';
import {
  BOX_HALO,
  HIGHLIGHT_RING,
  MARK_SHADOW,
  MarksLayer,
  TEXT_INPUT_WIDTH,
  arrowShaftPath,
  marksCss,
  tint,
  useMarks,
  type MarksApi,
} from '../ui/MarksLayer';

let host: HTMLDivElement;
let api: MarksApi;
const dispatch = vi.fn();
const onTextEdit = vi.fn();
const onDrawing = vi.fn();
const onOpen = vi.fn();
let seq = 0;

interface HarnessProps {
  tool: Tool;
  color?: MarkColor;
  popoverId?: string | null;
  hoveredId?: string | null;
}

function Harness(p: HarnessProps) {
  api = useMarks(dispatch);
  return (
    <>
      <MarksLayer
        marks={api.marks}
        tool={p.tool}
        color={p.color ?? DEFAULT_MARK_COLOR}
        popoverId={p.popoverId}
        hoveredId={p.hoveredId}
        onCreate={api.add}
        onOpen={onOpen}
        onTextEdit={onTextEdit}
        onDrawing={onDrawing}
        newId={() => `id${++seq}`}
      />
      <button type="button" data-part="undo" onClick={() => api.undo()}>
        Undo
      </button>
    </>
  );
}

let current: HarnessProps;
function mount(p: HarnessProps): void {
  current = p;
  act(() => render(<Harness {...p} />, host));
}
function rerender(over: Partial<HarnessProps>): void {
  mount({ ...current, ...over });
}

beforeEach(() => {
  seq = 0;
  dispatch.mockReset();
  onTextEdit.mockReset();
  onDrawing.mockReset();
  onOpen.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => render(null, host));
  host.remove();
});

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const $$ = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));
const hit = () => $('[data-part="marks-hit"]')!;
const marks = () => api.marks as Mark[];

function pointer(type: string, x: number, y: number, el: Element = hit()): void {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0 }));
  });
}
function drag(from: [number, number], ...to: [number, number][]): void {
  pointer('pointerdown', ...from);
  for (const p of to) pointer('pointermove', ...p);
  const last = to[to.length - 1] ?? from;
  pointer('pointerup', ...last);
}
function key(el: Element, k: string): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('pin (§5.4)', () => {
  it('drops a numbered pin on click with its tip at the click point', () => {
    mount({ tool: 'pin' });
    pointer('pointerdown', 100, 200);
    expect(marks()).toEqual([{ id: 'id1', kind: 'pin', color: DEFAULT_MARK_COLOR, x: 100, y: 200, n: 1 }]);
    expect(dispatch).toHaveBeenCalledWith({ type: 'addMark', id: 'id1' });
    const pin = $('[data-mark-kind="pin"]')!;
    expect(pin.textContent).toBe('1');
    expect(pin.style.left).toBe('100px');
    expect(pin.style.top).toBe('172px'); // y − 28: the click point is the bottom-left tip
    expect(pin.style.boxShadow).toBe(MARK_SHADOW);
    expect(pin.className).toBe('fw-mk-pin');
  });

  it('styles the pin 28×28, radius 14/14/14/3, 2 px white border, mono 700 12/24', () => {
    const css = marksCss();
    const rule = css.split('\n').find((l) => l.startsWith('.fw-mk-pin{'))!;
    expect(rule).toContain('width:28px;height:28px');
    expect(rule).toContain('border:2px solid #fff');
    expect(rule).toContain('border-radius:14px 14px 14px 3px');
    expect(rule).toMatch(/font:700 12px\/24px 'JetBrains Mono'/);
  });

  it('colours the pin with the selected colour and its §5.4 text colour', () => {
    mount({ tool: 'pin', color: MARK_COLORS.amber });
    pointer('pointerdown', 10, 40);
    const pin = $('[data-mark-kind="pin"]')!;
    expect(pin.style.background).toMatch(/#f4b942|rgb\(244, 185, 66\)/);
    expect(pin.style.color).toMatch(/#1a1612|rgb\(26, 22, 18\)/);
  });

  it('clicking a pin re-opens its popover instead of dropping another pin', () => {
    mount({ tool: 'pin' });
    pointer('pointerdown', 100, 200);
    const pin = $('[data-mark-kind="pin"]')!;
    pointer('pointerdown', 105, 190, pin);
    act(() => pin.click());
    expect(onOpen).toHaveBeenCalledWith('id1');
    expect(marks()).toHaveLength(1);
  });
});

describe('box (§5.4)', () => {
  it('creates a box by drag in any direction, normalised to top-left', () => {
    mount({ tool: 'box' });
    drag([300, 260], [250, 230], [200, 210]);
    expect(marks()).toEqual([{ id: 'id1', kind: 'box', color: DEFAULT_MARK_COLOR, x: 200, y: 210, w: 100, h: 50, n: 1 }]);
    const box = $('[data-mark-kind="box"]')!;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['200px', '210px', '100px', '50px']);
    expect(box.style.background).toMatch(/rgba\(168, ?56, ?24, ?0\.1\)/);
    const badge = $('[data-badge-for="id1"]')!;
    expect(badge.textContent).toBe('1');
    expect([badge.style.left, badge.style.top]).toEqual(['188px', '198px']); // (x−12, y−12)
  });

  it('styles the box 2.5 px solid, radius 5, white halo; badge 24 px circle, mono 700 11', () => {
    const lines = marksCss().split('\n');
    const box = lines.find((l) => l.startsWith('.fw-mk-box{'))!;
    expect(box).toContain('border-radius:5px');
    expect(box).toContain('border-width:2.5px;border-style:solid');
    expect(box).toContain(`box-shadow:${BOX_HALO}`);
    const badge = lines.find((l) => l.startsWith('.fw-mk-badge{'))!;
    expect(badge).toContain('width:24px;height:24px');
    expect(badge).toContain('border:2px solid #fff');
    expect(badge).toContain('border-radius:50%');
    expect(badge).toMatch(/font:700 11px\/20px 'JetBrains Mono'/);
    expect(tint('#a83818', 0.1)).toBe('rgba(168,56,24,0.1)');
  });

  it('rejects a box smaller than 8×8 and shows a live preview while dragging', () => {
    mount({ tool: 'box' });
    pointer('pointerdown', 10, 10);
    pointer('pointermove', 60, 15);
    expect($('[data-mark-id="preview"]')).toBeTruthy();
    expect(onDrawing).toHaveBeenLastCalledWith(true);
    pointer('pointerup', 60, 15); // 50×5
    expect(onDrawing).toHaveBeenLastCalledWith(false);
    expect($('[data-mark-id="preview"]')).toBeNull();
    drag([10, 10], [17, 40]); // 7×30
    expect(marks()).toHaveLength(0);
    drag([10, 10], [18, 18]); // exactly 8×8 commits
    expect(marks()).toHaveLength(1);
  });
});

describe('arrow (§5.4)', () => {
  it('creates an arrow by drag and renders shaft + head over an 8 px white underlay', () => {
    mount({ tool: 'arrow' });
    drag([100, 100], [150, 100], [200, 100]);
    expect(marks()).toEqual([{ id: 'id1', kind: 'arrow', color: DEFAULT_MARK_COLOR, x1: 100, y1: 100, x2: 200, y2: 100 }]);
    const svg = $('[data-mark-kind="arrow"]')!;
    const paths = Array.from(svg.querySelectorAll('path'));
    expect(paths.map((p) => p.getAttribute('class'))).toEqual(['fw-mk-under', 'fw-mk-under-head', 'fw-mk-line', 'fw-mk-head']);
    const head = arrowHead(100, 100, 200, 100);
    expect(paths[3].getAttribute('d')).toBe(head.path);
    expect(paths[2].getAttribute('d')).toBe(arrowShaftPath({ x1: 100, y1: 100, x2: 200, y2: 100 }));
    expect(paths[2].getAttribute('d')).toBe('M100 100 L184 100'); // base 182 + 2 px overlap
    const css = marksCss();
    expect(css).toContain('.fw-mk-under{fill:none;stroke:rgba(255,255,255,.85);stroke-width:8');
    expect(css).toContain('.fw-mk-line{fill:none;stroke-width:4;stroke-linecap:round');
    expect(marks()[0].n).toBeUndefined();
  });

  it('rejects an arrow shorter than 14 px', () => {
    mount({ tool: 'arrow' });
    drag([100, 100], [110, 108]); // ≈12.8
    expect(marks()).toHaveLength(0);
    drag([100, 100], [114, 100]); // exactly 14
    expect(marks()).toHaveLength(1);
  });
});

describe('draw (§5.4)', () => {
  it('samples only moves > 2.5 px and renders the smoothed path with the underlay', () => {
    mount({ tool: 'draw' });
    drag([10, 10], [11, 11], [20, 10], [21, 10], [30, 20], [40, 25]);
    const m = marks()[0];
    expect(m.kind).toBe('draw');
    if (m.kind !== 'draw') return;
    expect(m.points).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 20 },
      { x: 40, y: 25 },
    ]);
    const svg = $('[data-mark-kind="draw"]')!;
    const paths = Array.from(svg.querySelectorAll('path'));
    expect(paths.map((p) => p.getAttribute('class'))).toEqual(['fw-mk-under', 'fw-mk-line']);
    expect(paths[1].getAttribute('d')).toBe(drawPath(m.points));
    expect(paths[1].getAttribute('d')).toContain('Q');
    expect(m.n).toBeUndefined();
  });

  it('rejects a drawing with fewer than 3 points', () => {
    mount({ tool: 'draw' });
    drag([10, 10], [11, 11], [12, 10], [20, 10]); // samples: (10,10), (20,10)
    expect(marks()).toHaveLength(0);
  });
});

describe('text (§5.4)', () => {
  const input = () => $<HTMLInputElement>('[data-part="text-input"]');

  it('places a 240 px dashed input in the mark colour; Enter commits a chip', () => {
    mount({ tool: 'text', color: MARK_COLORS.green });
    pointer('pointerdown', 50, 80);
    const el = input()!;
    expect(el).toBeTruthy();
    expect(document.activeElement).toBe(el);
    expect(onTextEdit).toHaveBeenLastCalledWith(true);
    expect(el.style.left).toBe('50px');
    expect(el.style.borderColor).toMatch(/#2e5a3e|rgb\(46, 90, 62\)/);
    const rule = marksCss().split('\n').find((l) => l.startsWith('.fw-mk-input{'))!;
    expect(rule).toContain(`width:${TEXT_INPUT_WIDTH}px`);
    expect(TEXT_INPUT_WIDTH).toBe(240);
    expect(rule).toContain('border-width:2px;border-style:dashed;background:#fff');
    expect(rule).toMatch(/font:600 15px/);
    type(el, '  Wrong price  ');
    const e = key(el, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(input()).toBeNull();
    expect(onTextEdit).toHaveBeenLastCalledWith(false);
    expect(marks()).toEqual([{ id: 'id1', kind: 'text', color: MARK_COLORS.green, x: 50, y: 80, text: 'Wrong price' }]);
    const chip = $('[data-mark-kind="text"]')!;
    expect(chip.textContent).toBe('Wrong price');
    expect(chip.style.top).toBe('65px'); // y − 15
    const chipRule = marksCss().split('\n').find((l) => l.startsWith('.fw-mk-text{'))!;
    expect(chipRule).toContain('max-width:300px;padding:4px 10px;border-radius:7px');
    expect(chipRule).toContain('box-shadow:0 0 0 2px #fff, 0 3px 8px rgba(26,22,18,.3)');
  });

  it('blur commits', () => {
    mount({ tool: 'text' });
    pointer('pointerdown', 50, 80);
    type(input()!, 'Blurred');
    act(() => input()!.blur());
    expect(input()).toBeNull();
    expect(marks().map((m) => m.kind === 'text' && m.text)).toEqual(['Blurred']);
  });

  it('a click elsewhere commits the open label without placing a new one', () => {
    mount({ tool: 'text' });
    pointer('pointerdown', 50, 80);
    type(input()!, 'First');
    pointer('pointerdown', 300, 300);
    expect(input()).toBeNull();
    expect(marks()).toHaveLength(1);
  });

  it('Esc cancels without creating a mark and does not reach the page', () => {
    mount({ tool: 'text' });
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    pointer('pointerdown', 50, 80);
    type(input()!, 'Nope');
    key(input()!, 'Escape');
    document.removeEventListener('keydown', outer);
    expect(outer).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    expect(onTextEdit).toHaveBeenLastCalledWith(false);
    expect(marks()).toHaveLength(0);
  });

  it('empty or whitespace-only text is discarded', () => {
    mount({ tool: 'text' });
    pointer('pointerdown', 50, 80);
    type(input()!, '   ');
    key(input()!, 'Enter');
    pointer('pointerdown', 60, 90);
    act(() => input()!.blur());
    expect(marks()).toHaveLength(0);
  });
});

describe('element marks (§5.4)', () => {
  it('renders a dashed box with the selector chip and number badge; the element tool creates nothing here', () => {
    mount({ tool: 'element' });
    pointer('pointerdown', 10, 10);
    expect(marks()).toHaveLength(0);
    act(() => api.add({ id: 'e1', kind: 'element', color: DEFAULT_MARK_COLOR, x: 40, y: 50, w: 120, h: 30, selector: 'button.book' }));
    const box = $('[data-mark-kind="element"]')!;
    expect(box.className).toBe('fw-mk-box fw-mk-element');
    expect(marksCss()).toContain('.fw-mk-box.fw-mk-element{border-style:dashed}');
    const chip = $('.fw-mk-sel')!;
    expect(chip.textContent).toBe('button.book');
    expect([chip.style.left, chip.style.top]).toEqual(['56px', '45px']);
    expect($('[data-badge-for="e1"]')!.textContent).toBe('1');
  });
});

describe('numbering, delete and undo', () => {
  it('numbers pins and boxes 1…n in creation order and renumbers after delete', () => {
    mount({ tool: 'pin' });
    pointer('pointerdown', 10, 40); // pin 1
    rerender({ tool: 'arrow' });
    drag([0, 0], [50, 50]); // arrow, unnumbered
    rerender({ tool: 'box' });
    drag([100, 100], [150, 150]); // box 2
    rerender({ tool: 'pin' });
    pointer('pointerdown', 300, 300); // pin 3
    expect(marks().map((m) => [m.kind, m.n])).toEqual([
      ['pin', 1],
      ['arrow', undefined],
      ['box', 2],
      ['pin', 3],
    ]);
    act(() => api.remove('id1'));
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'removeMark', id: 'id1' });
    expect(marks().map((m) => [m.id, m.n])).toEqual([
      ['id2', undefined],
      ['id3', 1],
      ['id4', 2],
    ]);
    expect($('[data-badge-for="id3"]')!.textContent).toBe('1');
    expect($('[data-mark-id="id4"]')!.textContent).toBe('2');
  });

  it('Undo removes the last mark of any kind', () => {
    mount({ tool: 'pin' });
    pointer('pointerdown', 10, 40);
    rerender({ tool: 'draw' });
    drag([0, 0], [10, 0], [20, 0]);
    expect(marks().map((m) => m.kind)).toEqual(['pin', 'draw']);
    act(() => $('[data-part="undo"]')!.click());
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'undoMark' });
    expect(marks().map((m) => m.kind)).toEqual(['pin']);
    expect($$('[data-mark-kind="draw"]')).toHaveLength(0);
    act(() => $('[data-part="undo"]')!.click());
    expect(marks()).toHaveLength(0);
    dispatch.mockReset();
    act(() => $('[data-part="undo"]')!.click());
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('highlight ring (§5.4)', () => {
  it('rings a badge while its panel row is hovered or its popover is open', () => {
    mount({ tool: 'pin' });
    pointer('pointerdown', 10, 40);
    rerender({ tool: 'box' });
    drag([100, 100], [150, 150]);
    const pin = () => $('[data-mark-id="id1"]')!;
    const badge = () => $('[data-badge-for="id2"]')!;
    expect(pin().style.boxShadow).toBe(MARK_SHADOW);
    expect(badge().style.boxShadow).toBe(MARK_SHADOW);
    rerender({ hoveredId: 'id2' });
    expect(badge().style.boxShadow).toBe(HIGHLIGHT_RING);
    expect(pin().style.boxShadow).toBe(MARK_SHADOW);
    rerender({ hoveredId: null, popoverId: 'id1' });
    expect(pin().style.boxShadow).toBe(HIGHLIGHT_RING);
    expect(badge().style.boxShadow).toBe(MARK_SHADOW);
    expect(HIGHLIGHT_RING).toBe('0 0 0 4px rgba(244,185,66,.75), 0 2px 6px rgba(26,22,18,.35)');
  });
});
