import { render } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MARK_COLOR, type BoxMark, type ElementMark, type Mark, type PinMark } from '../ui/marks';
import { MarksLayer, useMarks } from '../ui/MarksLayer';
import {
  AUTOFOCUS_DELAY_MS,
  COMMENT_MAX,
  PLACEHOLDERS,
  POPOVER_SHADOW,
  POPOVER_WIDTH,
  Popover,
  markBBox,
  popoverCss,
  popoverLabel,
  popoverPosition,
  type CommentMark,
} from '../ui/Popover';

const W = 1280;
const H = 800;
const c = DEFAULT_MARK_COLOR;
const pin: PinMark = { id: 'p1', kind: 'pin', color: c, x: 300, y: 300, n: 2 };
const box: BoxMark = { id: 'b1', kind: 'box', color: c, x: 400, y: 200, w: 100, h: 80, n: 3 };
const el: ElementMark = { id: 'e1', kind: 'element', color: c, x: 100, y: 100, w: 80, h: 30, selector: 'button.book', n: 1 };

let host: HTMLDivElement;
const onComment = vi.fn();
const onDelete = vi.fn();
const onClose = vi.fn();

function mountPopover(mark: CommentMark, size = { W, H }) {
  act(() =>
    render(
      <Popover mark={mark} W={size.W} H={size.H} onComment={onComment} onDelete={onDelete} onClose={onClose} />,
      host,
    ),
  );
  return host.querySelector<HTMLDivElement>('[data-part="popover"]')!;
}
const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)!;

function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

function input(ta: HTMLTextAreaElement, value: string) {
  ta.value = value;
  act(() => {
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  onComment.mockReset();
  onDelete.mockReset();
  onClose.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => render(null, host));
  host.remove();
  vi.useRealTimers();
});

describe('popoverPosition (§5.5)', () => {
  it('sits right of the mark: left = bbox.right + 12, top = bbox.top − 4', () => {
    expect(popoverPosition({ x: 400, y: 200, w: 100, h: 80 }, W, H)).toEqual({ left: 512, top: 196 });
  });

  it('flips to bbox.left − 284 at the right edge', () => {
    // right edge exactly fits: 1280 − 12 − 272 = 996
    expect(popoverPosition({ x: 884, y: 200, w: 100, h: 50 }, W, H).left).toBe(996);
    // one px further passes W − 12 → flip
    expect(popoverPosition({ x: 885, y: 200, w: 100, h: 50 }, W, H).left).toBe(885 - 284);
  });

  it('clamps left to 12 at the left edge (after a flip that goes negative)', () => {
    // a wide mark on a narrow surface: right side overflows, flipped left is negative
    expect(popoverPosition({ x: 100, y: 200, w: 300, h: 50 }, 600, H).left).toBe(12);
    expect(popoverPosition({ x: 280, y: 200, w: 300, h: 50 }, 600, H).left).toBe(12);
  });

  it('clamps top to 12 at the top edge', () => {
    expect(popoverPosition({ x: 100, y: 0, w: 20, h: 20 }, W, H).top).toBe(12);
    expect(popoverPosition({ x: 100, y: 16, w: 20, h: 20 }, W, H).top).toBe(12);
    expect(popoverPosition({ x: 100, y: 17, w: 20, h: 20 }, W, H).top).toBe(13);
  });

  it('clamps top to H − 180 at the bottom edge', () => {
    expect(popoverPosition({ x: 100, y: 784, w: 20, h: 20 }, W, H).top).toBe(620);
    expect(popoverPosition({ x: 100, y: 624, w: 20, h: 20 }, W, H).top).toBe(620);
    expect(popoverPosition({ x: 100, y: 623, w: 20, h: 20 }, W, H).top).toBe(619);
  });

  it('uses the 28 px pin box for a pin and the rect for a box/element', () => {
    expect(markBBox(pin)).toEqual({ x: 300, y: 272, w: 28, h: 28 });
    expect(markBBox(box)).toEqual({ x: 400, y: 200, w: 100, h: 80 });
  });

  it('positions the rendered popover with CSSOM left/top', () => {
    const p = mountPopover(box);
    expect(p.style.left).toBe('512px');
    expect(p.style.top).toBe('196px');
    expect(p.getAttribute('style')).not.toBeNull();
  });
});

describe('Popover rendering', () => {
  it('container: width 272 and the §5.5 style', () => {
    const css = popoverCss();
    expect(POPOVER_WIDTH).toBe(272);
    expect(css).toContain('width:272px');
    expect(css).toContain('background:#f5f0e6');
    expect(css).toContain('border:1px solid #d4ccb8');
    expect(css).toContain('border-radius:12px');
    expect(css).toContain(`box-shadow:${POPOVER_SHADOW}`);
    expect(POPOVER_SHADOW).toBe('0 18px 44px -14px rgba(26,22,18,.55)');
  });

  it('header: badge, mono label, Delete', () => {
    mountPopover(pin);
    expect(q('[data-part="popover-badge"]').textContent).toBe('2');
    expect(q('[data-part="popover-label"]').textContent).toBe('Pin 2');
    expect(q('[data-part="popover-delete"]').textContent).toBe('Delete');
    expect(popoverLabel(box)).toBe('Box 3');
    expect(popoverLabel(el)).toBe('button.book');
  });

  it('footer: hint and Save', () => {
    mountPopover(pin);
    expect(host.textContent).toContain('↵ save · esc close');
    expect(q('[data-part="popover-save"]').textContent).toBe('Save');
  });

  it.each([
    [pin, "What's wrong here?"],
    [el, 'What about this element?'],
    [box, "What's going on in this area?"],
  ] as const)('placeholder for %s.kind', (mark, ph) => {
    mountPopover(mark);
    const ta = q<HTMLTextAreaElement>('[data-part="popover-text"]');
    expect(ta.placeholder).toBe(ph);
    expect(PLACEHOLDERS[mark.kind]).toBe(ph);
    expect(ta.rows).toBe(2);
  });

  it('caps the comment at 1000 characters', () => {
    mountPopover(pin);
    const ta = q<HTMLTextAreaElement>('[data-part="popover-text"]');
    expect(ta.maxLength).toBe(COMMENT_MAX);
    expect(COMMENT_MAX).toBe(1000);
    input(ta, 'x'.repeat(1200));
    expect(onComment).toHaveBeenLastCalledWith('p1', 'x'.repeat(1000));
    expect(ta.value.length).toBe(1000);
  });

  it('autofocuses the textarea after 40 ms', () => {
    vi.useFakeTimers();
    mountPopover(pin);
    const ta = q<HTMLTextAreaElement>('[data-part="popover-text"]');
    vi.advanceTimersByTime(AUTOFOCUS_DELAY_MS - 1);
    expect(document.activeElement).not.toBe(ta);
    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(ta);
  });

  it('Delete calls onDelete with the mark id', () => {
    mountPopover(box);
    act(() => q<HTMLButtonElement>('[data-part="popover-delete"]').click());
    expect(onDelete).toHaveBeenCalledWith('b1');
  });

  it('Enter saves and closes; Shift+Enter adds a newline', () => {
    mountPopover(pin);
    const ta = q<HTMLTextAreaElement>('[data-part="popover-text"]');
    const shift = key(ta, 'Enter', { shiftKey: true });
    expect(shift.defaultPrevented).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    const enter = key(ta, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc and Save close', () => {
    mountPopover(pin);
    key(q('[data-part="popover-text"]'), 'Escape');
    act(() => q<HTMLButtonElement>('[data-part="popover-save"]').click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// ── MarksLayer hook-up ─────────────────────────────────────────────────────

let api: ReturnType<typeof useMarks>;
let setPop: (id: string | null) => void;
let seq = 0;

function Harness({ initial = [] as Mark[] }) {
  api = useMarks();
  const [pop, set] = useState<string | null>(null);
  setPop = set;
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    initial.forEach((m) => api.add(m));
  }
  return (
    <MarksLayer
      marks={api.marks}
      tool="pin"
      color={c}
      popoverId={pop}
      onCreate={api.add}
      newId={() => `id${++seq}`}
      popover={{
        onChange: set,
        onComment: (id, v) => api.update(id, { comment: v }),
        onDelete: api.remove,
        W,
        H,
      }}
    />
  );
}

function down(target: Element, x: number, y: number) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, pointerId: 1 }),
    );
  });
}

describe('MarksLayer popover hook-up', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('opens after creating a pin, saves a comment, closes on a surface click without a new mark', () => {
    act(() => render(<Harness />, host));
    const hit = q('[data-part="marks-hit"]');
    down(hit, 50, 60);
    expect(api.marks).toHaveLength(1);
    const p = q('[data-part="popover"]');
    expect(p.getAttribute('data-popover-for')).toBe('id1');
    input(q<HTMLTextAreaElement>('[data-part="popover-text"]'), 'broken');
    expect((api.marks[0] as PinMark).comment).toBe('broken');
    down(hit, 400, 400);
    expect(host.querySelector('[data-part="popover"]')).toBeNull();
    expect(api.marks).toHaveLength(1);
  });

  it('opens when a numbered badge is clicked, and Delete removes the mark and closes', () => {
    act(() => render(<Harness initial={[box]} />, host));
    expect(host.querySelector('[data-part="popover"]')).toBeNull();
    act(() => q<HTMLButtonElement>('[data-badge-for="b1"]').click());
    expect(q('[data-part="popover"]').getAttribute('data-popover-for')).toBe('b1');
    expect(q('[data-part="popover-label"]').textContent).toBe('Box 1');
    act(() => q<HTMLButtonElement>('[data-part="popover-delete"]').click());
    expect(api.marks).toHaveLength(0);
    expect(host.querySelector('[data-part="popover"]')).toBeNull();
  });

  it('renders for an element mark opened by its owner', () => {
    act(() => render(<Harness initial={[el]} />, host));
    act(() => setPop('e1'));
    expect(q('[data-part="popover-label"]').textContent).toBe('button.book');
    key(q('[data-part="popover-text"]'), 'Enter');
    expect(host.querySelector('[data-part="popover"]')).toBeNull();
  });
});
