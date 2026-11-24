// Floating ink toolbar, `dock` variant — handoff README §5.3 "Toolbar" with the §8 icons.
// Order: grip · Pin · Element · Box · Arrow · Draw · Text · divider · 4 swatches · divider ·
// Undo · [Describe — flow annotate only] · Close.
//
// Strict-CSP rule (DESIGN_SPEC.md "Decided changes" 3): every static style lives in one
// constructed stylesheet (toolbarSheet(), adopted into the component's own root node on mount);
// the only per-render style writes are left/top, through CSSOM properties — never a `style`
// attribute or a <style> element.
//
// The drag offset is controlled: the parent passes the machine's `toolbarPos` as `offset` and
// dispatches `moveToolbar` from `onMove`. The machine resets `toolbarPos` on every open, which
// is what puts the toolbar back at its dock position.

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Flow, Tool } from './machine';
import { DEFAULT_MARK_COLOR, MARK_COLORS, type MarkColor } from './marks';
import { colors, fonts, motion } from './tokens';

// ── Data ────────────────────────────────────────────────────────────────────

export interface ToolSpec {
  id: Tool;
  label: string;
  key: string;
}

export const TOOLS: readonly ToolSpec[] = [
  { id: 'pin', label: 'Pin', key: 'P' },
  { id: 'element', label: 'Element', key: 'E' },
  { id: 'box', label: 'Box', key: 'R' },
  { id: 'arrow', label: 'Arrow', key: 'A' },
  { id: 'draw', label: 'Draw', key: 'D' },
  { id: 'text', label: 'Text', key: 'T' },
];

export interface SwatchSpec {
  label: string;
  color: MarkColor;
}

/** §5.3 swatches; Rust is the default mark colour. */
export const SWATCHES: readonly SwatchSpec[] = [
  { label: 'Rust', color: MARK_COLORS.rust },
  { label: 'Amber', color: MARK_COLORS.amber },
  { label: 'Green', color: MARK_COLORS.green },
  { label: 'Ink', color: MARK_COLORS.ink },
];

/** §8 icon paths (24×24 viewBox). Circles/rects are drawn separately in <Icon>. */
export const ICONS = {
  pin: ['M12 21.5c-.7-2.6-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0c0 5-5.8 8.6-6.5 11.2z'],
  element: [
    'M4.5 9V5.5a1 1 0 0 1 1-1H9M15 4.5h3.5a1 1 0 0 1 1 1V9M4.5 15v3.5a1 1 0 0 0 1 1H9',
    'M13.2 13.2l7.3 2.5-3.1 1.4-1.4 3.1z',
  ],
  box: [] as string[],
  arrow: ['M5 19L18.5 5.5M10.5 5h8.5v8.5'],
  draw: ['M3.5 16.5c2.2-3.6 4.2-5.3 5.7-3.9 1.6 1.5-.4 4.3 1.6 4.8 2.2.5 3.6-6.2 6.4-7.2 1.9-.7 3 1 3.3 2.3'],
  text: ['M5.5 7.5V5h13v2.5M12 5v14M9 19h6'],
  undo: ['M9 14.5L4.5 10 9 5.5', 'M4.5 10h9.5a5.5 5.5 0 0 1 0 11H11'],
  close: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
} as const;

/** Grip dots (10×16 viewBox, r 1.4). */
const GRIP_DOTS: readonly [number, number][] = [
  [2.5, 3], [7.5, 3], [2.5, 8], [7.5, 8], [2.5, 13], [7.5, 13],
];

/** Width the docked panel column takes out of the free area (panel 380 + 32 gutter). */
export const DOCKED_PANEL_COLUMN = 412;
const DOCK_TOP = 16;

export interface FreeArea {
  x0: number;
  x1: number;
}

/** §5.3 free area: the whole viewport, except flow `docked` excludes the panel column. */
export function freeArea(W: number, flow: Flow, panelSide: 'left' | 'right' = 'right'): FreeArea {
  if (flow !== 'docked') return { x0: 0, x1: W };
  return panelSide === 'right'
    ? { x0: 0, x1: W - DOCKED_PANEL_COLUMN }
    : { x0: DOCKED_PANEL_COLUMN, x1: W };
}

// ── Styles ──────────────────────────────────────────────────────────────────

const PAPER_LINE = 'rgba(245,240,230,.16)';
const PAPER_HOVER = 'rgba(245,240,230,.1)';

/** Text of the toolbar's constructed stylesheet. */
export function toolbarCss(): string {
  const { ink, amber, paper } = colors;
  return [
    `.fw-tb{position:fixed;z-index:25;display:flex;flex-direction:row;align-items:center;gap:3px;padding:6px;` +
      `background:${ink};border-radius:14px;` +
      `box-shadow:0 18px 40px -14px rgba(26,22,18,.7),inset 0 0 0 1px rgba(245,240,230,.07);` +
      `transform:translate(-50%,0);opacity:1;visibility:visible;` +
      `transition:opacity 250ms,transform 350ms ${motion.ease},visibility 350ms}`,
    `.fw-tb.fw-tb-hidden{transform:translate(-50%,-12px);opacity:0;visibility:hidden}`,
    `.fw-tb svg{display:block}`,
    `.fw-tb-ico{fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`,
    // Grip
    `.fw-tb-grip{display:flex;align-items:center;justify-content:center;width:18px;height:40px;` +
      `cursor:grab;touch-action:none;color:${colors['ink-4']}}`,
    `.fw-tb-grip:active{cursor:grabbing}`,
    `.fw-tb-grip svg{fill:currentColor}`,
    // Tool buttons
    `.fw-tb-slot{position:relative;display:flex}`,
    `.fw-tb-tool{display:flex;align-items:center;justify-content:center;` +
      `width:40px;height:40px;border-radius:9px;background:transparent;color:${colors['paper-3']};` +
      `transition:background 150ms,color 150ms}`,
    `.fw-tb-tool.fw-tb-on{background:${amber};color:${ink}}`,
    // Tooltip (dock → below)
    `.fw-tb-tip{position:absolute;z-index:2;left:50%;top:50px;transform:translateX(-50%);` +
      `display:flex;align-items:center;gap:7px;` +
      `padding:5px 8px;border-radius:7px;background:${paper};color:${ink};` +
      `font:600 12px ${fonts.sans};white-space:nowrap;` +
      `box-shadow:0 6px 16px -6px rgba(26,22,18,.5);pointer-events:none}`,
    `.fw-tb-key{font:500 10.5px ${fonts.mono};padding:1px 5px;border-radius:4px;background:${colors['paper-3']};color:${colors['ink-3']}}`,
    // Divider
    `.fw-tb-div{flex:none;width:1px;height:24px;background:${PAPER_LINE};margin:0 5px}`,
    // Swatches
    `.fw-tb-sw{display:flex;align-items:center;justify-content:center;width:24px;height:40px;background:transparent;padding:0}`,
    `.fw-tb-dot{display:block;width:16px;height:16px;border-radius:50%;box-shadow:0 0 0 1.5px rgba(245,240,230,.4)}`,
    `.fw-tb-sw.fw-tb-on .fw-tb-dot{box-shadow:0 0 0 2px ${ink},0 0 0 4px ${amber}}`,
    ...SWATCHES.map((s, i) => `.fw-tb-sw-${i} .fw-tb-dot{background:${s.color}}`),
    // Undo / Close
    `.fw-tb-undo,.fw-tb-close{display:flex;align-items:center;justify-content:center;` +
      `width:40px;height:40px;border-radius:9px;background:transparent}`,
    `.fw-tb-undo{color:${colors['paper-3']}}`,
    `.fw-tb-close{color:${colors['rule-strong']}}`,
    `.fw-tb-undo:hover,.fw-tb-close:hover{background:${PAPER_HOVER}}`,
    // Describe (row layouts)
    `.fw-tb-next{display:flex;align-items:center;gap:8px;` +
      `height:40px;margin-left:4px;padding:0 10px 0 14px;border-radius:9px;background:${amber};` +
      `color:${ink};font:700 13.5px ${fonts.sans};white-space:nowrap}`,
    `.fw-tb-next:hover{background:${colors['amber-hover']}}`,
    `.fw-tb-chip{font:500 11px ${fonts.mono};padding:2px 6px;border-radius:4px;background:rgba(26,22,18,.12)}`,
    `.fw-tb button:focus-visible{outline:2px solid ${amber};outline-offset:2px}`,
    // §4: reduced motion drops translate motion and caps fades at 150 ms.
    `@media (prefers-reduced-motion:reduce){` +
      `.fw-tb{transition:opacity 150ms,visibility 150ms}` +
      `.fw-tb.fw-tb-hidden{transform:translate(-50%,0)}` +
      `.fw-tb-tool{transition:background 150ms,color 150ms}}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

/** The toolbar's one constructed stylesheet (null where constructable sheets are missing). */
export function toolbarSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(toolbarCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

function adoptInto(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!root || !('adoptedStyleSheets' in root) || !Array.isArray(root.adoptedStyleSheets)) return;
  const sheet = toolbarSheet();
  if (!sheet || root.adoptedStyleSheets.includes(sheet)) return;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Sheet from another document/realm — the host mounts it instead.
  }
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg class="fw-tb-ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {name === 'box' && <rect x="4" y="5.5" width="16" height="13" rx="1.5" />}
      {ICONS[name].map((d) => (
        <path key={d} d={d} />
      ))}
      {name === 'pin' && <circle cx="12" cy="10.2" r="2.3" />}
    </svg>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export interface ToolbarProps {
  /** §2: shown only in `annotate` (toolbarVisible(state)). */
  visible: boolean;
  tool: Tool;
  color: MarkColor;
  /** Drag offset from the dock position (machine `toolbarPos`); null = at rest. */
  offset: { x: number; y: number } | null;
  flow?: Flow;
  panelSide?: 'left' | 'right';
  /** Viewport width; defaults to window.innerWidth, tracked on resize. */
  viewportWidth?: number;
  onTool(tool: Tool): void;
  onColor(color: MarkColor): void;
  onUndo(): void;
  onDescribe(): void;
  onClose(): void;
  onMove(pos: { x: number; y: number }): void;
}

interface DragStart {
  id: number;
  x: number;
  y: number;
  ox: number;
  oy: number;
}

function useViewportWidth(given: number | undefined): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useLayoutEffect(() => {
    if (given !== undefined || typeof window === 'undefined') return;
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [given]);
  return given ?? w;
}

export function Toolbar(props: ToolbarProps) {
  const { visible, tool, color = DEFAULT_MARK_COLOR, offset, flow = 'annotate', panelSide = 'right' } = props;
  const W = useViewportWidth(props.viewportWidth);
  const [tip, setTip] = useState<Tool | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<DragStart | null>(null);

  useLayoutEffect(() => {
    if (ref.current) adoptInto(ref.current);
  }, []);

  const area = freeArea(W, flow, panelSide);
  const ox = offset?.x ?? 0;
  const oy = offset?.y ?? 0;
  const left = (area.x0 + area.x1) / 2 + ox;
  const top = DOCK_TOP + oy;

  const gripDown = (e: PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Not capturable (synthetic pointer) — moves still track while over the grip.
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, ox, oy };
  };
  const gripMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    props.onMove({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const gripUp = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    drag.current = null;
    const el = e.currentTarget as HTMLElement;
    try {
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
  };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Markup tools"
      aria-hidden={visible ? undefined : 'true'}
      class={visible ? 'fw-tb' : 'fw-tb fw-tb-hidden'}
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      <div
        data-part="grip"
        class="fw-tb-grip"
        title="Drag to move"
        onPointerDown={gripDown}
        onPointerMove={gripMove}
        onPointerUp={gripUp}
        onPointerCancel={gripUp}
      >
        <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
          {GRIP_DOTS.map(([cx, cy]) => (
            <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="1.4" />
          ))}
        </svg>
      </div>

      {TOOLS.map((t) => {
        const on = t.id === tool;
        return (
          <div key={t.id} data-part="tool" class="fw-tb-slot">
            <button
              type="button"
              class={on ? 'fw-tb-tool fw-tb-on' : 'fw-tb-tool'}
              aria-label={t.label}
              aria-pressed={on ? 'true' : 'false'}
              aria-keyshortcuts={t.key}
              onClick={() => props.onTool(t.id)}
              onMouseEnter={() => setTip(t.id)}
              onMouseLeave={() => setTip((cur) => (cur === t.id ? null : cur))}
              onFocus={() => setTip(t.id)}
              onBlur={() => setTip((cur) => (cur === t.id ? null : cur))}
            >
              <Icon name={t.id} />
            </button>
            {tip === t.id && (
              <div class="fw-tb-tip" role="tooltip">
                {t.label}
                <span class="fw-tb-key">{t.key}</span>
              </div>
            )}
          </div>
        );
      })}

      <span data-part="divider" class="fw-tb-div" />

      {SWATCHES.map((s, i) => {
        const on = s.color === color;
        return (
          <button
            key={s.label}
            type="button"
            data-part="swatch"
            class={`fw-tb-sw fw-tb-sw-${i}${on ? ' fw-tb-on' : ''}`}
            aria-label={s.label}
            aria-pressed={on ? 'true' : 'false'}
            onClick={() => props.onColor(s.color)}
          >
            <span class="fw-tb-dot" />
          </button>
        );
      })}

      <span data-part="divider" class="fw-tb-div" />

      <button
        type="button"
        data-part="undo"
        class="fw-tb-undo"
        aria-label="Undo"
        title="Undo (⌘Z)"
        onClick={() => props.onUndo()}
      >
        <Icon name="undo" />
      </button>

      {flow === 'annotate' && (
        <button type="button" data-part="describe" class="fw-tb-next" onClick={() => props.onDescribe()}>
          Describe
          <span class="fw-tb-chip">↵</span>
        </button>
      )}

      <button
        type="button"
        data-part="close"
        class="fw-tb-close"
        aria-label="Close"
        title="Close (Esc)"
        onClick={() => props.onClose()}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
