// Panel, flows `annotate`, `docked` and `note` — handoff README §5.6: Container, Geometry
// "annotate — corner card", "docked — side panel" (with Swap side) and "note — anchored note", Header, Body (Type · Title · Details) and Footer (reporter + Send
// with upload progress). Visibility from §2 (machine.panelVisible); the Send/Esc/⌘↵ semantics
// stay in the machine — this component only dispatches.
//
// The "Marks on screenshot" and "Attached automatically" sections live in PanelContext.tsx;
// the caller renders <PanelContext> as `children` (it slots in below Details).
//
// Strict-CSP rule (tokens.ts): every static style lives in one constructed stylesheet adopted on
// the panel's own root; the only per-render style write is the progress bar width, through the
// CSSOM — never a `style` attribute or a <style> element.

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { FeedbackUser } from '../host';
import type { ReportType } from '../report';
import { panelVisible, type Event, type State } from './machine';
import { isNumbered, type Mark } from './marks';
import { isCommentMark, markBBox } from './Popover';
import { Receipt, receiptCss } from './Receipt';
import { adoptInto, type PanelSide } from './shared';
import { colors, fonts, motion } from './tokens';

// ── Copy & rules (§5.6) ───────────────────────────────────────────────────────

export const EYEBROW = 'Step 2 of 2 · Describe';
export const HEADLINE = 'Describe what you marked';
export const BACK_LABEL = '← Marks';
/** Flow `docked` header copy (§5.6). */
export const DOCKED_HEADLINE = "What's going on?";
export const SWAP_TITLE = 'Move panel to the other side';

export function dockedEyebrow(hostname: string): string {
  return `Feedback · ${hostname}`;
}

function currentHostname(): string {
  return typeof location === 'undefined' ? '' : location.hostname;
}
export const TITLE_ERROR = 'Add a short title so the team can find this.';
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const DETAILS_MAX = 5000;
export const DETAILS_ROWS = 4;
/** §5.6 Error banner (mode `error`); a 4xx (`rejected`) result swaps the body copy (§1 Submission). */
export const ERROR_TITLE = "Couldn't reach the feedback server";
export const ERROR_BODY_RETRY = 'Nothing is lost — this report is saved in your browser and will retry on its own.';
export const ERROR_BODY_REJECTED = "The feedback server didn't accept this report.";

export function errorBody(kind: State['errorKind']): string {
  return kind === 'rejected' ? ERROR_BODY_REJECTED : ERROR_BODY_RETRY;
}

/** Describe → Title focus delay (§2). */
export const FOCUS_TITLE_DELAY_MS = 420;

// ── Flow `note` (§5.6 "note — anchored note", §4 focus) ────────────────────────

export const NOTE_WIDTH = 340;
/** Gap between the anchor and the note. */
export const NOTE_GAP = 18;
/** Minimum distance from every viewport edge. */
export const NOTE_EDGE = 16;
/** Half the note's nominal height — the note centres on the anchor (cy − 170). */
export const NOTE_HALF = 170;
export const NOTE_DETAILS_ROWS = 3;
/** First mark → Title focus delay (§4). */
export const NOTE_FOCUS_TITLE_DELAY_MS = 380;
export const NOTE_EYEBROW_UNNUMBERED = 'Your note';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** On-screen box of any mark (pin = its 28 px head, text = its chip, arrow/draw = their extent). */
export function noteAnchorBox(m: Mark): Box {
  if (isCommentMark(m)) return markBBox(m);
  if (m.kind === 'text') return { x: m.x, y: m.y - 15, w: Math.min(300, 22 + m.text.length * 8.4), h: 30 };
  if (m.kind === 'arrow') {
    return { x: Math.min(m.x1, m.x2), y: Math.min(m.y1, m.y2), w: Math.abs(m.x2 - m.x1), h: Math.abs(m.y2 - m.y1) };
  }
  const xs = m.points.map((p) => p.x);
  const ys = m.points.map((p) => p.y);
  const x = xs.length ? Math.min(...xs) : 0;
  const y = ys.length ? Math.min(...ys) : 0;
  return { x, y, w: xs.length ? Math.max(...xs) - x : 0, h: ys.length ? Math.max(...ys) - y : 0 };
}

export interface NoteGeometry {
  left: number;
  /** Set when the anchor centre is in the top half (the note grows downward). */
  top: number | null;
  /** Set when the anchor centre is in the bottom half (the note grows upward). */
  bottom: number | null;
  maxHeight: number;
  /** The note sits on the anchor's right (else its left). */
  side: 'right' | 'left';
}

/**
 * §5.6 note geometry: left = anchor.right + 18, or anchor.left − 358 if that overflows; clamp to
 * [16, W − 356]. With cy = anchor centre: cy ≤ H/2 → top = max(16, cy − 170); otherwise
 * bottom = max(16, H − cy − 170). Max-height H − 32. No anchor → a 40 px box at the centre.
 */
export function noteGeometry(anchor: Box | null, W: number, H: number): NoteGeometry {
  const a = anchor ?? { x: W / 2 - 20, y: H / 2 - 20, w: 40, h: 40 };
  let left = a.x + a.w + NOTE_GAP;
  let side: NoteGeometry['side'] = 'right';
  if (left + NOTE_WIDTH > W - NOTE_EDGE) {
    left = a.x - NOTE_WIDTH - NOTE_GAP;
    side = 'left';
  }
  left = Math.max(NOTE_EDGE, Math.min(left, W - NOTE_WIDTH - NOTE_EDGE));
  const cy = a.y + a.h / 2;
  const maxHeight = Math.max(0, H - 2 * NOTE_EDGE);
  if (cy <= H / 2) return { left, top: Math.max(NOTE_EDGE, cy - NOTE_HALF), bottom: null, maxHeight, side };
  return { left, top: null, bottom: Math.max(NOTE_EDGE, H - cy - NOTE_HALF), maxHeight, side };
}

/**
 * §5.5: a new pin, box or element opens its comment popover — except the first mark in flow
 * `note`, which opens the note instead (§5.6). `existing` = marks before this one.
 */
export function markOpensPopover(flow: State['config']['flow'], existing: number): boolean {
  return !(flow === 'note' && existing === 0);
}

/** §5.6 note eyebrow: "Note on mark 1 · {selector}" (selector for an element), or "Your note". */
export function noteEyebrow(first: Mark | undefined): string {
  if (!first || !isNumbered(first)) return NOTE_EYEBROW_UNNUMBERED;
  const base = `Note on mark ${first.n ?? 1}`;
  return first.kind === 'element' && first.selector ? `${base} · ${first.selector}` : base;
}

export interface TypeSpec {
  id: ReportType;
  label: string;
  dot: string;
  titlePlaceholder: string;
  detailsPlaceholder: string;
}

export const TYPES: readonly TypeSpec[] = [
  {
    id: 'bug',
    label: 'Bug',
    dot: colors.accent,
    titlePlaceholder: 'e.g. Book button does nothing',
    detailsPlaceholder: 'What did you do, what happened, and what did you expect?',
  },
  {
    id: 'feature',
    label: 'Feature request',
    dot: colors.amber,
    titlePlaceholder: 'e.g. Let me save a stay for later',
    detailsPlaceholder: 'What are you trying to do, and what would make it easier?',
  },
  {
    id: 'other',
    label: 'Other',
    dot: colors['ink-4'],
    titlePlaceholder: 'One-line summary',
    detailsPlaceholder: 'Anything else we should know?',
  },
];

export const DEFAULT_TYPE: ReportType = 'bug';

/** §5.6 Title rule: required, trimmed length 3–120. */
export function titleValid(title: string): boolean {
  const n = title.trim().length;
  return n >= TITLE_MIN && n <= TITLE_MAX;
}

/** Send button label per mode (§5.6 Footer, §2 "Retry now"). */
export function sendButtonLabel(mode: State['mode'], progress: number): string {
  if (mode === 'sending') return `Sending… ${Math.max(0, Math.min(100, Math.round(progress)))}%`;
  if (mode === 'error') return 'Retry now';
  return 'Send feedback';
}

/** §3: "⌘↵" on macOS, "Ctrl↵" elsewhere. */
export function shortcutChip(platform: string = typeof navigator === 'undefined' ? '' : navigator.platform): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘↵' : 'Ctrl↵';
}

export interface Reporter {
  initials: string;
  name: string;
  sub: string;
}

/** §5.6 Footer: initials + name + "from site login", or the anonymous trio. */
export function reporterView(user: FeedbackUser | null | undefined): Reporter {
  const name = user ? (user.name || user.email || user.id || '').trim() : '';
  if (!name) return { initials: '?', name: 'Anonymous', sub: 'not signed in' };
  const words = (user?.name?.trim() ? user.name.trim() : name.split('@')[0] ?? name).split(/[\s._-]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? name).slice(0, 2)).toUpperCase();
  return { initials, name, sub: 'from site login' };
}

// ── Styles ────────────────────────────────────────────────────────────────────

export function panelCss(): string {
  const c = colors;
  const ease = motion.ease;
  return [
    `.fw-panel{position:fixed;z-index:30;right:20px;bottom:20px;width:380px;height:auto;max-height:calc(100vh - 40px);` +
      `display:flex;flex-direction:column;overflow:hidden;background:${c.paper};border:1px solid ${c.rule};border-radius:14px;` +
      `box-shadow:0 1px 0 rgba(42,36,28,.05), 0 24px 60px -18px rgba(26,22,18,.5);` +
      `transform-origin:right bottom;opacity:1;visibility:visible;transform:none;` +
      `transition:opacity 280ms ${ease}, transform 400ms ${ease}, visibility 400ms ${ease}, left 400ms ${ease}, top 400ms ${ease}}`,
    `.fw-panel--mini{right:auto;left:20px;transform-origin:left bottom}`,
    `.fw-panel--hidden{opacity:0;visibility:hidden;transform:translateY(16px) scale(.98);pointer-events:none}`,
    // Flow docked — side panel: top 16, bottom 16, right 16 (left 16 after a swap), width 380;
    // enters from translateX(±24px), sliding in from its own edge.
    `.fw-panel--docked{top:16px;bottom:16px;right:16px;left:auto;max-height:none;transform-origin:right center}`,
    `.fw-panel--docked.fw-panel--left{right:auto;left:16px;transform-origin:left center}`,
    `.fw-panel--docked.fw-panel--hidden{transform:translateX(24px)}`,
    `.fw-panel--docked.fw-panel--left.fw-panel--hidden{transform:translateX(-24px)}`,
    // Flow note — anchored note: width 340; left/top/bottom/max-height are per-anchor (CSSOM);
    // enters from translateY(8px) scale(.97).
    `.fw-panel--note{right:auto;bottom:auto;width:${NOTE_WIDTH}px;max-height:calc(100vh - 32px);transform-origin:left top}`,
    `.fw-panel--note.fw-panel--hidden{transform:translateY(8px) scale(.97)}`,
    `.fw-pn-progress{position:absolute;top:0;left:0;height:3px;width:0;background:${c.accent};z-index:1;transition:width 200ms ${ease}}`,
    // Header
    // Design review scene: one row — [eyebrow over headline] beside [← Marks][×], top-aligned. The
    // headline wraps against the buttons' column width (no max-width), exactly as the design.
    `.fw-pn-head{flex:none;display:flex;align-items:flex-start;gap:6px;padding:16px 12px 14px 20px;border-bottom:1px solid ${c.rule}}`,
    `.fw-pn-headtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:5px}`,
    `.fw-pn-eyebrow{min-width:0;font-family:${fonts.mono};font-weight:500;font-size:10.5px;line-height:1.3;letter-spacing:.1em;` +
      `text-transform:uppercase;color:${c.accent};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.fw-pn-headline{font-family:${fonts.serif};font-weight:600;font-size:22px;line-height:1.2;color:${c.ink}}`,
    `.fw-pn-back{flex:none;white-space:nowrap;height:30px;padding:0 10px;border-radius:7px;border:1px solid ${c.rule};font-weight:600;font-size:12.5px;color:${c['ink-2']}}`,
    `.fw-pn-back:hover{background:${c['paper-2']}}`,
    `.fw-pn-close{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;color:${c['ink-3']}}`,
    `.fw-pn-close:hover{background:${c['paper-3']}}`,
    `.fw-pn-swap{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;color:${c['ink-3']}}`,
    `.fw-pn-swap:hover{background:${c['paper-3']}}`,
    `.fw-pn-swap svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`,
    `.fw-pn-close svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`,
    // Body
    `.fw-pn-body{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding:16px 20px 18px}`,
    `.fw-pn-field{display:flex;flex-direction:column;gap:6px}`,
    `.fw-pn-labelrow{display:flex;align-items:baseline;justify-content:space-between}`,
    `.fw-pn-label{font-family:${fonts.mono};font-weight:500;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:${c['ink-3']}}`,
    `.fw-pn-opt{font-family:${fonts.mono};font-size:11px;color:${c['ink-3']}}`,
    `.fw-pn-seg{display:flex;gap:3px;padding:3px;background:${c['paper-2']};border:1px solid ${c.rule};border-radius:10px}`,
    `.fw-pn-segbtn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:7px 6px;border-radius:7px;` +
      `font-weight:600;font-size:13px;background:transparent;color:${c['ink-2']};white-space:nowrap}`,
    `.fw-pn-segbtn[aria-checked="true"]{background:${c.ink};color:${c.paper}}`,
    `.fw-pn-dot{flex:none;width:7px;height:7px;border-radius:999px}`,
    ...TYPES.map((t) => `.fw-pn-dot--${t.id}{background:${t.dot}}`),
    `.fw-pn-input,.fw-pn-textarea{width:100%;padding:10px 12px;border-radius:8px;border:1px solid ${c.rule};background:${c.field};color:${c.ink};outline:none}`,
    `.fw-pn-input{font-weight:500;font-size:15px}`,
    `.fw-pn-textarea{font-weight:400;font-size:14px;line-height:1.5;resize:vertical}`,
    `.fw-pn-input::placeholder,.fw-pn-textarea::placeholder{color:${c['ink-4']}}`,
    `.fw-pn-input:focus,.fw-pn-textarea:focus{border-color:${c.ink};box-shadow:0 0 0 3px rgba(244,185,66,.45)}`,
    `.fw-pn-error{font-weight:500;font-size:12.5px;color:${c.accent}}`,
    // Error banner (§5.6)
    `.fw-pn-banner{display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:9px;` +
      `background:rgba(168,56,24,.08);border:1px solid rgba(168,56,24,.35)}`,
    `.fw-pn-bang{flex:none;width:22px;height:22px;border-radius:999px;background:${c.accent};color:${c['on-accent']};` +
      `font-weight:700;font-size:13px;line-height:22px;text-align:center}`,
    `.fw-pn-bantext{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}`,
    `.fw-pn-bantitle{font-weight:600;font-size:14px;line-height:1.35;color:${c.ink}}`,
    `.fw-pn-banbody{font-weight:400;font-size:13px;line-height:1.45;color:${c['ink-2']}}`,
    // Footer
    `.fw-pn-foot{flex:none;display:flex;align-items:center;gap:12px;padding:12px 14px 12px 20px;border-top:1px solid ${c.rule};background:${c['paper-2']}}`,
    `.fw-pn-avatar{flex:none;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:999px;` +
      `background:${c.ink};color:${c.paper};font-family:${fonts.serif};font-weight:600;font-size:12px}`,
    `.fw-pn-who{flex:1;min-width:0;display:flex;flex-direction:column}`,
    `.fw-pn-name{font-weight:600;font-size:13px;color:${c.ink};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.fw-pn-sub{font-family:${fonts.mono};font-size:10.5px;color:${c['ink-3']}}`,
    `.fw-pn-send{flex:none;display:flex;align-items:center;gap:10px;height:40px;padding:0 10px 0 16px;border-radius:9px;` +
      `background:${c.accent};color:${c['on-accent']};font-weight:600;font-size:14px;white-space:nowrap;transition:background-color 200ms ${ease}, opacity 200ms ${ease}}`,
    `.fw-pn-send:hover{background:${c['accent-hover']}}`,
    `.fw-pn-send--invalid{opacity:.55}`,
    `.fw-pn-key{font-family:${fonts.mono};font-weight:500;font-size:11px;padding:2px 6px;border-radius:5px;background:rgba(255,248,239,.16)}`,
    `.fw-panel button:focus-visible{outline:2px solid ${c.amber};outline-offset:2px}`,
    `.fw-panel :disabled{cursor:default}`,
    // Receipt (§5.7) — same sheet, so the strict-CSP one-sheet rule holds.
    receiptCss(),
    // §4 reduced motion: no translate/scale, fades capped at 150 ms.
    `@media (prefers-reduced-motion:reduce){` +
      `.fw-panel{transition:opacity 150ms, visibility 150ms}` +
      `.fw-panel--hidden,.fw-panel--note.fw-panel--hidden,.fw-panel--docked.fw-panel--hidden,.fw-panel--docked.fw-panel--left.fw-panel--hidden{transform:none}}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

/** The panel's one constructed stylesheet (null where constructable sheets are missing). */
export function panelSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(panelCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface PanelProps {
  state: State;
  dispatch: (e: Event) => void;
  /** Upload progress 0–100 while `sending`. */
  progress?: number;
  /** Reporter from FeedbackConfig.user / identify(); null → Anonymous. */
  user?: FeedbackUser | null;
  /** Controlled report type; omitted → the panel keeps its own (default Bug, reset per open). */
  reportType?: ReportType;
  onType?: (t: ReportType) => void;
  /** Launcher variant `mini` puts the card bottom-left (flow annotate only). */
  mini?: boolean;
  /** Flow `docked`: which side the panel sits on. Omitted → the panel keeps its own (default right). */
  side?: PanelSide;
  /** Flow `docked`: Swap side was pressed; receives the new side. */
  onSwap?: (side: PanelSide) => void;
  /** Eyebrow hostname for flow `docked` (defaults to location.hostname). */
  hostname?: string;
  /** Override for the shortcut chip platform test (defaults to navigator.platform). */
  platform?: string;
  /** Flow `note`: every mark (creation order); the first one anchors the note. */
  marks?: readonly Mark[];
  /** Flow `note`: viewport size for the note geometry (defaults to window.innerWidth/innerHeight). */
  viewport?: { width: number; height: number };
  /** Receipt "Screenshot" / "Console" / "Network" rows (§5.7); defaults: viewport size, nothing captured. */
  attached?: PanelAttached;
  /** Marks / Attached sections (rendered below Details). */
  children?: ComponentChildren;
}

export interface PanelAttached {
  width: number;
  height: number;
  console: { count: number; on: boolean };
  network: { count: number; on: boolean };
}

function defaultAttached(): PanelAttached {
  const w = typeof window === 'undefined' ? 0 : window.innerWidth;
  const h = typeof window === 'undefined' ? 0 : window.innerHeight;
  return { width: w, height: h, console: { count: 0, on: true }, network: { count: 0, on: true } };
}

export function Panel(props: PanelProps) {
  const { state, dispatch, progress = 0, user = null, mini = false } = props;
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [ownType, setOwnType] = useState<{ session: number; type: ReportType }>({ session: state.session, type: DEFAULT_TYPE });
  const type = props.reportType ?? (ownType.session === state.session ? ownType.type : DEFAULT_TYPE);
  const spec = TYPES.find((t) => t.id === type) ?? TYPES[0]!;

  const [ownSide, setOwnSide] = useState<PanelSide>('right');
  const flow = state.config.flow;
  const docked = flow === 'docked';
  const side = props.side ?? ownSide;
  const note = flow === 'note';
  const visible = panelVisible(state);
  const sending = state.mode === 'sending';
  const showBack = flow === 'annotate' && (state.mode === 'review' || state.mode === 'error');
  const firstMark = props.marks?.[0];
  const eyebrow = docked ? dockedEyebrow(props.hostname ?? currentHostname()) : note ? noteEyebrow(firstMark) : EYEBROW;
  const headline = docked ? DOCKED_HEADLINE : note ? '' : HEADLINE;
  const vw = props.viewport?.width ?? (typeof window === 'undefined' ? 0 : window.innerWidth);
  const vh = props.viewport?.height ?? (typeof window === 'undefined' ? 0 : window.innerHeight);
  const geo = note ? noteGeometry(firstMark ? noteAnchorBox(firstMark) : null, vw, vh) : null;
  const invalid = !titleValid(state.draft.title);
  const reporter = reporterView(user);
  const showReceipt = state.mode === 'sent' && state.config.success === 'receipt';
  const attached = props.attached ?? defaultAttached();

  useLayoutEffect(() => {
    adoptInto(ref.current, panelSheet());
  }, []);

  // Progress bar width through the CSSOM (strict CSP).
  useLayoutEffect(() => {
    if (barRef.current) barRef.current.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }, [progress, sending]);

  // Flow note geometry through the CSSOM (strict CSP); cleared for the other flows.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!geo) {
      for (const p of ['left', 'top', 'bottom', 'max-height', 'transform-origin']) el.style.removeProperty(p);
      return;
    }
    el.style.left = `${geo.left}px`;
    el.style.top = geo.top === null ? 'auto' : `${geo.top}px`;
    el.style.bottom = geo.bottom === null ? 'auto' : `${geo.bottom}px`;
    el.style.maxHeight = `${geo.maxHeight}px`;
    el.style.transformOrigin = `${geo.side === 'right' ? 'left' : 'right'} ${geo.top === null ? 'bottom' : 'top'}`;
  }, [geo?.left, geo?.top, geo?.bottom, geo?.maxHeight, geo?.side, note]);

  // Flow note, first mark: focus Title 380 ms later (§4).
  const lastMarks = useRef(state.marks.length);
  useLayoutEffect(() => {
    const prev = lastMarks.current;
    lastMarks.current = state.marks.length;
    if (!note || prev !== 0 || state.marks.length === 0 || state.mode !== 'annotate') return;
    const t = setTimeout(() => titleRef.current?.focus(), NOTE_FOCUS_TITLE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.marks.length, note, state.mode]);

  // Title focus: immediately on a title error, else 420 ms after Describe (§2).
  const lastSeq = useRef(state.focusTitleSeq);
  useLayoutEffect(() => {
    if (state.focusTitleSeq === lastSeq.current) return;
    lastSeq.current = state.focusTitleSeq;
    if (state.titleError) {
      titleRef.current?.focus();
      return;
    }
    const t = setTimeout(() => titleRef.current?.focus(), FOCUS_TITLE_DELAY_MS);
    return () => clearTimeout(t);
  }, [state.focusTitleSeq, state.titleError]);

  /** §5.6 Swap side: move the panel and put the toolbar back at its rest position. */
  const swap = () => {
    if (sending) return;
    const next: PanelSide = side === 'right' ? 'left' : 'right';
    setOwnSide(next);
    props.onSwap?.(next);
    dispatch({ type: 'moveToolbar', pos: null });
  };

  const pickType = (t: ReportType) => {
    if (sending) return;
    setOwnType({ session: state.session, type: t });
    props.onType?.(t);
  };

  return (
    <div
      ref={ref}
      class={`fw-panel${docked ? ` fw-panel--docked${side === 'left' ? ' fw-panel--left' : ''}` : note ? ' fw-panel--note' : mini ? ' fw-panel--mini' : ''}${visible ? '' : ' fw-panel--hidden'}`}
      data-side={docked ? side : geo ? geo.side : undefined}
      data-flow={flow}
      role="region"
      aria-label={showReceipt ? 'Feedback received' : 'Describe your feedback'}
      aria-hidden={visible ? undefined : 'true'}
      aria-busy={sending ? 'true' : undefined}
    >
      {sending && <div ref={barRef} class="fw-pn-progress" data-part="progress" />}

      {showReceipt ? (
        <Receipt
          id={state.reportId}
          user={user}
          typeLabel={spec.label}
          title={state.draft.title}
          screenshot={{ width: attached.width, height: attached.height, marks: state.marks.length }}
          console={attached.console}
          network={attached.network}
          onSendAnother={() => dispatch({ type: 'sendAnother' })}
          onDone={() => dispatch({ type: 'done' })}
        />
      ) : (
      <>
      <div class="fw-pn-head">
        <div class="fw-pn-headtext">
          <div class="fw-pn-eyebrow" data-part="eyebrow">{eyebrow}</div>
          {headline && <h2 class="fw-pn-headline" data-part="headline">{headline}</h2>}
        </div>
        {showBack && (
          <button type="button" class="fw-pn-back" data-part="back" onClick={() => dispatch({ type: 'backToMarks' })}>
            {BACK_LABEL}
          </button>
        )}
        {docked && !sending && (
          <button type="button" class="fw-pn-swap" data-part="swap" title={SWAP_TITLE} aria-label={SWAP_TITLE} onClick={swap}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 8h15M15 4l4 4-4 4M20 16H5M9 12l-4 4 4 4" />
            </svg>
          </button>
        )}
        <button
          type="button"
          class="fw-pn-close"
          data-part="close"
          aria-label="Close"
          disabled={sending}
          onClick={() => dispatch({ type: 'closeRequest' })}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div class="fw-pn-body">
        {state.mode === 'error' && (
          <div class="fw-pn-banner" data-part="error-banner" role="alert">
            <span class="fw-pn-bang" aria-hidden="true">
              !
            </span>
            <div class="fw-pn-bantext">
              <div class="fw-pn-bantitle" data-part="error-title">
                {ERROR_TITLE}
              </div>
              <div class="fw-pn-banbody" data-part="error-body">
                {errorBody(state.errorKind)}
              </div>
            </div>
          </div>
        )}

        <div class="fw-pn-field">
          <div class="fw-pn-label" id="fw-pn-type-label">Type</div>
          <div class="fw-pn-seg" role="radiogroup" aria-labelledby="fw-pn-type-label">
            {TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                class="fw-pn-segbtn"
                data-type={t.id}
                aria-checked={t.id === type ? 'true' : 'false'}
                disabled={sending}
                onClick={() => pickType(t.id)}
              >
                <span class={`fw-pn-dot fw-pn-dot--${t.id}`} aria-hidden="true" />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div class="fw-pn-field">
          <label class="fw-pn-label" for="fw-pn-title">
            Title
          </label>
          <input
            ref={titleRef}
            id="fw-pn-title"
            class="fw-pn-input"
            type="text"
            required
            minLength={TITLE_MIN}
            maxLength={TITLE_MAX}
            placeholder={spec.titlePlaceholder}
            value={state.draft.title}
            disabled={sending}
            aria-invalid={state.titleError ? 'true' : undefined}
            aria-describedby={state.titleError ? 'fw-pn-title-error' : undefined}
            onInput={(e) => dispatch({ type: 'draft', title: (e.currentTarget as HTMLInputElement).value })}
          />
          {state.titleError && (
            <div id="fw-pn-title-error" class="fw-pn-error" role="alert">
              {TITLE_ERROR}
            </div>
          )}
        </div>

        <div class="fw-pn-field">
          <div class="fw-pn-labelrow">
            <label class="fw-pn-label" for="fw-pn-details">
              Details
            </label>
            <span class="fw-pn-opt">optional</span>
          </div>
          <textarea
            id="fw-pn-details"
            class="fw-pn-textarea"
            rows={note ? NOTE_DETAILS_ROWS : DETAILS_ROWS}
            maxLength={DETAILS_MAX}
            placeholder={spec.detailsPlaceholder}
            value={state.draft.body}
            disabled={sending}
            onInput={(e) => dispatch({ type: 'draft', body: (e.currentTarget as HTMLTextAreaElement).value })}
          />
        </div>

        {props.children}
      </div>

      <div class="fw-pn-foot">
        <div class="fw-pn-avatar" data-part="avatar" aria-hidden="true">
          {reporter.initials}
        </div>
        <div class="fw-pn-who">
          <div class="fw-pn-name" data-part="name">
            {reporter.name}
          </div>
          <div class="fw-pn-sub" data-part="sub">
            {reporter.sub}
          </div>
        </div>
        <button
          type="button"
          class={`fw-pn-send${invalid ? ' fw-pn-send--invalid' : ''}`}
          data-part="send"
          disabled={sending}
          onClick={() => dispatch({ type: 'send' })}
        >
          <span data-part="send-label">{sendButtonLabel(state.mode, progress)}</span>
          <span class="fw-pn-key" aria-hidden="true">
            {shortcutChip(props.platform)}
          </span>
        </button>
      </div>
      </>
      )}
    </div>
  );
}
