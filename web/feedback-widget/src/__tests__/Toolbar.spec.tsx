import { render } from 'preact';
import { useReducer } from 'preact/hooks';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, reduce, toolbarVisible, type Tool } from '../ui/machine';
import { DEFAULT_MARK_COLOR, MARK_COLORS, type MarkColor } from '../ui/marks';
import {
  ICONS,
  SWATCHES,
  TOOLS,
  Toolbar,
  toolbarCss,
  type ToolbarProps,
} from '../ui/Toolbar';
import { freeArea } from '../ui/shared';

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => render(null, host));
  host.remove();
});

function props(over: Partial<ToolbarProps> = {}): ToolbarProps {
  return {
    visible: true,
    tool: 'pin',
    color: DEFAULT_MARK_COLOR,
    offset: null,
    viewportWidth: 1280,
    onTool: vi.fn(),
    onColor: vi.fn(),
    onUndo: vi.fn(),
    onDescribe: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    ...over,
  };
}

function mount(p: ToolbarProps): void {
  act(() => render(<Toolbar {...p} />, host));
}

const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
const $$ = (sel: string) => Array.from(host.querySelectorAll<HTMLElement>(sel));
const bar = () => $('[role="toolbar"]');

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function pointer(el: Element, type: string, x: number, y: number): void {
  act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
  });
}

describe('Toolbar order (§5.3)', () => {
  it('renders grip, six tools, divider, four swatches, divider, Undo, Describe, Close in order', () => {
    mount(props());
    const kinds = Array.from(bar().children).map((c) => (c as HTMLElement).dataset.part);
    expect(kinds).toEqual([
      'grip',
      'tool', 'tool', 'tool', 'tool', 'tool', 'tool',
      'divider',
      'swatch', 'swatch', 'swatch', 'swatch',
      'divider',
      'undo',
      'describe',
      'close',
    ]);
    expect($$('[data-part="tool"] button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Pin', 'Element', 'Box', 'Arrow', 'Draw', 'Text',
    ]);
    expect(TOOLS.map((t) => t.key)).toEqual(['P', 'E', 'R', 'A', 'D', 'T']);
  });

  it('omits Describe outside flow annotate', () => {
    mount(props({ flow: 'docked' }));
    expect($$('[data-part="describe"]')).toHaveLength(0);
    expect($('[data-part="close"]')).toBeTruthy();
  });

  it('draws the §8 icon paths on a 24×24 viewBox', () => {
    mount(props());
    const pin = $('[data-part="tool"] svg');
    expect(pin.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(pin.getAttribute('width')).toBe('20');
    expect(pin.querySelector('path')!.getAttribute('d')).toBe(
      'M12 21.5c-.7-2.6-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0c0 5-5.8 8.6-6.5 11.2z',
    );
    const c = pin.querySelector('circle')!;
    expect([c.getAttribute('cx'), c.getAttribute('cy'), c.getAttribute('r')]).toEqual(['12', '10.2', '2.3']);
    const rect = $$('[data-part="tool"] svg')[2].querySelector('rect')!;
    expect(['x', 'y', 'width', 'height', 'rx'].map((a) => rect.getAttribute(a))).toEqual(['4', '5.5', '16', '13', '1.5']);
    expect($('[data-part="undo"] svg').innerHTML).toContain('M4.5 10h9.5a5.5 5.5 0 0 1 0 11H11');
    const close = $('[data-part="close"] svg');
    expect(close.getAttribute('width')).toBe('18');
    expect(close.querySelector('path')!.getAttribute('d')).toBe('M6.5 6.5l11 11M17.5 6.5l-11 11');
    expect(ICONS.arrow).toEqual(['M5 19L18.5 5.5M10.5 5h8.5v8.5']);
    expect(ICONS.draw).toEqual([
      'M3.5 16.5c2.2-3.6 4.2-5.3 5.7-3.9 1.6 1.5-.4 4.3 1.6 4.8 2.2.5 3.6-6.2 6.4-7.2 1.9-.7 3 1 3.3 2.3',
    ]);
    expect(ICONS.text).toEqual(['M5.5 7.5V5h13v2.5M12 5v14M9 19h6']);
    expect(ICONS.element).toEqual([
      'M4.5 9V5.5a1 1 0 0 1 1-1H9M15 4.5h3.5a1 1 0 0 1 1 1V9M4.5 15v3.5a1 1 0 0 0 1 1H9',
      'M13.2 13.2l7.3 2.5-3.1 1.4-1.4 3.1z',
    ]);
    const grip = $('[data-part="grip"] svg');
    expect(grip.getAttribute('viewBox')).toBe('0 0 10 16');
    expect(grip.querySelectorAll('circle')).toHaveLength(6);
  });

  it('carries every §5.3 size, colour, radius, shadow and transition in its sheet', () => {
    const css = toolbarCss();
    for (const needle of [
      'background:#1a1612',
      'border-radius:14px',
      'padding:6px',
      'gap:3px',
      'box-shadow:0 18px 40px -14px rgba(26,22,18,.7),inset 0 0 0 1px rgba(245,240,230,.07)',
      'transition:opacity 250ms,transform 350ms cubic-bezier(.2,.8,.2,1),visibility 350ms',
      'width:18px;height:40px', // grip
      'width:40px;height:40px;border-radius:9px', // tool button
      'transition:background 150ms,color 150ms',
      'color:#e3dcc8',
      'background:#f4b942;color:#1a1612', // active tool
      'padding:5px 8px;border-radius:7px;background:#f5f0e6;color:#1a1612',
      'box-shadow:0 6px 16px -6px rgba(26,22,18,.5)',
      'top:50px', // dock tooltip below
      'padding:1px 5px;border-radius:4px;background:#e3dcc8;color:#5d5648',
      'width:1px;height:24px;background:rgba(245,240,230,.16);margin:0 5px',
      'width:24px;height:40px', // swatch hit area
      'width:16px;height:16px',
      'box-shadow:0 0 0 1.5px rgba(245,240,230,.4)',
      'box-shadow:0 0 0 2px #1a1612,0 0 0 4px #f4b942',
      'background:rgba(245,240,230,.1)', // undo / close hover
      'height:40px;margin-left:4px;padding:0 10px 0 14px;border-radius:9px;background:#f4b942',
      'background:#f7c766', // describe hover
      'padding:2px 6px;border-radius:4px;background:rgba(26,22,18,.12)',
      'color:#c9bfa9', // close icon
      'cursor:grab',
      'translate(-50%,-12px)',
      'opacity:0',
    ]) {
      expect(css).toContain(needle);
    }
  });
});

describe('Toolbar events', () => {
  it('selects a tool', () => {
    const p = props();
    mount(p);
    click($$('[data-part="tool"] button')[3]);
    expect(p.onTool).toHaveBeenCalledWith('arrow');
  });

  it('selects a colour; rust is the default and is marked selected', () => {
    const p = props();
    mount(p);
    expect(SWATCHES.map((s) => s.label)).toEqual(['Rust', 'Amber', 'Green', 'Ink']);
    const sw = $$('[data-part="swatch"]');
    expect(sw[0].getAttribute('aria-label')).toBe('Rust');
    expect(sw[0].getAttribute('aria-pressed')).toBe('true');
    expect(sw[0].classList.contains('fw-tb-on')).toBe(true);
    expect(sw[1].getAttribute('aria-pressed')).toBe('false');
    click(sw[2]);
    expect(p.onColor).toHaveBeenCalledWith(MARK_COLORS.green);
  });

  it('fires undo, Describe and close', () => {
    const p = props();
    mount(p);
    click($('[data-part="undo"]'));
    click($('[data-part="describe"]'));
    click($('[data-part="close"]'));
    expect(p.onUndo).toHaveBeenCalledTimes(1);
    expect(p.onDescribe).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    expect($('[data-part="undo"]').getAttribute('title')).toBe('Undo (⌘Z)');
    expect($('[data-part="describe"]').textContent).toBe('Describe↵');
  });
});

describe('Toolbar accessibility', () => {
  it('sets aria-pressed and aria-label on tool buttons', () => {
    mount(props({ tool: 'box' }));
    const btns = $$('[data-part="tool"] button');
    expect(btns.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'false', 'false', 'true', 'false', 'false', 'false',
    ]);
    expect(btns[2].classList.contains('fw-tb-on')).toBe(true);
  });

  it('shows the tooltip with its key chip on hover and on focus', () => {
    mount(props());
    const btns = $$('[data-part="tool"] button');
    expect($$('.fw-tb-tip')).toHaveLength(0);
    act(() => {
      btns[1].dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect($$('.fw-tb-tip')).toHaveLength(1);
    expect($('.fw-tb-tip').textContent).toBe('ElementE');
    expect($('.fw-tb-tip .fw-tb-key').textContent).toBe('E');
    act(() => {
      btns[1].dispatchEvent(new MouseEvent('mouseleave'));
    });
    expect($$('.fw-tb-tip')).toHaveLength(0);
    act(() => {
      btns[5].dispatchEvent(new FocusEvent('focus'));
    });
    expect($('.fw-tb-tip').textContent).toBe('TextT');
    act(() => {
      btns[5].dispatchEvent(new FocusEvent('blur'));
    });
    expect($$('.fw-tb-tip')).toHaveLength(0);
  });
});

describe('Toolbar placement (§5.3)', () => {
  it('sits at top 16, centred in the free area', () => {
    mount(props({ viewportWidth: 1280 }));
    expect(bar().style.left).toBe('640px');
    expect(bar().style.top).toBe('16px');
    expect(bar().classList.contains('fw-tb-hidden')).toBe(false);
  });

  it('centres in the docked free area beside the panel', () => {
    expect(freeArea(1280, 'annotate')).toEqual({ x0: 0, x1: 1280 });
    expect(freeArea(1280, 'docked', 'right')).toEqual({ x0: 0, x1: 868 });
    expect(freeArea(1280, 'docked', 'left')).toEqual({ x0: 412, x1: 1280 });
    mount(props({ flow: 'docked', panelSide: 'right', viewportWidth: 1280 }));
    expect(bar().style.left).toBe('434px');
  });

  it('hides with the hidden class (translateY(-12px), opacity 0) and aria-hidden', () => {
    mount(props({ visible: false }));
    expect(bar().classList.contains('fw-tb-hidden')).toBe(true);
    expect(bar().getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Toolbar drag', () => {
  it('moves by the pointer delta with pointer capture', () => {
    const p = props();
    mount(p);
    const grip = $('[data-part="grip"]');
    const capture = vi.fn();
    (grip as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = capture;
    pointer(grip, 'pointerdown', 100, 100);
    expect(capture).toHaveBeenCalledWith(1);
    pointer(grip, 'pointermove', 130, 90);
    expect(p.onMove).toHaveBeenLastCalledWith({ x: 30, y: -10 });
    pointer(grip, 'pointerup', 130, 90);
    pointer(grip, 'pointermove', 200, 200);
    expect(p.onMove).toHaveBeenCalledTimes(1);
  });

  it('resets the dragged position on every open', () => {
    let dispatch!: (e: Parameters<typeof reduce>[1]) => void;
    function Harness() {
      const [s, d] = useReducer(reduce, undefined, () => initialState());
      dispatch = d;
      return (
        <Toolbar
          {...props()}
          visible={toolbarVisible(s)}
          tool={s.tool}
          offset={s.toolbarPos}
          onTool={(tool: Tool) => d({ type: 'setTool', tool })}
          onColor={(_c: MarkColor) => undefined}
          onClose={() => d({ type: 'closeRequest' })}
          onMove={(pos) => d({ type: 'moveToolbar', pos })}
        />
      );
    }
    act(() => render(<Harness />, host));
    act(() => dispatch({ type: 'open' }));
    const grip = $('[data-part="grip"]');
    pointer(grip, 'pointerdown', 10, 10);
    pointer(grip, 'pointermove', 60, 40);
    pointer(grip, 'pointerup', 60, 40);
    expect(bar().style.left).toBe('690px');
    expect(bar().style.top).toBe('46px');
    click($('[data-part="close"]'));
    expect(bar().classList.contains('fw-tb-hidden')).toBe(true);
    act(() => dispatch({ type: 'open' }));
    expect(bar().style.left).toBe('640px');
    expect(bar().style.top).toBe('16px');
  });
});

describe('Toolbar rail placement (§5.3)', () => {
  it('sits at freeArea.x0 + 20, vertically centred, in the column layout', () => {
    mount(props({ placement: 'rail', viewportWidth: 1280, viewportHeight: 800 }));
    expect(bar().classList.contains('fw-tb-rail')).toBe(true);
    expect(bar().getAttribute('aria-orientation')).toBe('vertical');
    expect(bar().style.left).toBe('20px');
    expect(bar().style.top).toBe('400px');
    act(() => render(null, host));
    mount(props({ placement: 'rail', flow: 'docked', panelSide: 'left', viewportWidth: 1280, viewportHeight: 800 }));
    expect(bar().style.left).toBe('432px');
  });

  it('applies the drag offset from its rest position', () => {
    mount(props({ placement: 'rail', offset: { x: 15, y: -40 }, viewportWidth: 1280, viewportHeight: 800 }));
    expect(bar().style.left).toBe('35px');
    expect(bar().style.top).toBe('360px');
  });

  it('carries the column sizes: rotated grip, 24×1 dividers, 40×24 swatches, 40×40 Describe', () => {
    const css = toolbarCss();
    for (const needle of [
      '.fw-tb-rail{flex-direction:column;transform:translate(0,-50%)}',
      '.fw-tb-rail.fw-tb-hidden{transform:translate(-12px,-50%)}',
      '.fw-tb-rail .fw-tb-grip{width:40px;height:18px}',
      '.fw-tb-rail .fw-tb-grip svg{transform:rotate(90deg)}',
      '.fw-tb-rail .fw-tb-div{width:24px;height:1px;margin:5px 0}',
      '.fw-tb-rail .fw-tb-sw{width:40px;height:24px}',
      '.fw-tb-rail .fw-tb-next{justify-content:center;width:40px;height:40px;margin:4px 0 0;padding:0}',
      '.fw-tb-rail .fw-tb-tip{left:50px;top:50%;transform:translateY(-50%)}',
    ]) {
      expect(css).toContain(needle);
    }
  });

  it('renders Describe as an amber square with the → icon', () => {
    const p = props({ placement: 'rail' });
    mount(p);
    const d = $('[data-part="describe"]');
    expect(d.classList.contains('fw-tb-next')).toBe(true);
    expect(d.getAttribute('aria-label')).toBe('Describe');
    expect(d.textContent).toBe('');
    expect(d.querySelector('svg path')!.getAttribute('d')).toBe(ICONS.next[0]);
    expect(d.querySelector('.fw-tb-chip')).toBeNull();
    click(d);
    expect(p.onDescribe).toHaveBeenCalledTimes(1);
  });

  it('puts tooltips to the right and hides with the hidden class', () => {
    mount(props({ placement: 'rail', visible: false }));
    expect(bar().classList.contains('fw-tb-hidden')).toBe(true);
    act(() => render(null, host));
    mount(props({ placement: 'rail' }));
    act(() => {
      $$('[data-part="tool"] button')[0].dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect($('.fw-tb-tip').dataset.side).toBe('right');
  });
});

describe('Toolbar corner placement (§5.3)', () => {
  it('puts its right edge at freeArea.x1 − 20 and its bottom at 20, row layout', () => {
    mount(props({ placement: 'corner', viewportWidth: 1280, viewportHeight: 800 }));
    expect(bar().classList.contains('fw-tb-corner')).toBe(true);
    expect(bar().getAttribute('aria-orientation')).toBe('horizontal');
    expect(bar().style.left).toBe('1260px');
    expect(bar().style.bottom).toBe('20px');
    expect(bar().style.top).toBe('');
    expect(toolbarCss()).toContain('.fw-tb-corner{transform:translate(-100%,0)}');
    act(() => render(null, host));
    mount(props({ placement: 'corner', flow: 'docked', panelSide: 'right', viewportWidth: 1280, viewportHeight: 800 }));
    expect(bar().style.left).toBe('848px');
  });

  it('applies the drag offset from its rest position', () => {
    mount(props({ placement: 'corner', offset: { x: -30, y: -50 }, viewportWidth: 1280, viewportHeight: 800 }));
    expect(bar().style.left).toBe('1230px');
    expect(bar().style.bottom).toBe('70px');
  });

  it('keeps the row Describe, puts tooltips above and hides with translateY(12px)', () => {
    const css = toolbarCss();
    expect(css).toContain('.fw-tb-corner.fw-tb-hidden{transform:translate(-100%,12px)}');
    expect(css).toContain('.fw-tb-corner .fw-tb-tip{top:auto;bottom:50px}');
    mount(props({ placement: 'corner' }));
    expect($('[data-part="describe"]').textContent).toBe('Describe↵');
    act(() => {
      $$('[data-part="tool"] button')[2].dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect($('.fw-tb-tip').dataset.side).toBe('above');
  });
});

describe('Toolbar dock default (§5.3)', () => {
  it('defaults to dock with tooltips below', () => {
    mount(props());
    expect(bar().dataset.placement).toBe('dock');
    expect(bar().classList.contains('fw-tb-dock')).toBe(true);
    expect(toolbarCss()).toContain('.fw-tb-dock.fw-tb-hidden{transform:translate(-50%,-12px)}');
    act(() => {
      $$('[data-part="tool"] button')[0].dispatchEvent(new FocusEvent('focus'));
    });
    expect($('.fw-tb-tip').dataset.side).toBe('below');
  });
});
