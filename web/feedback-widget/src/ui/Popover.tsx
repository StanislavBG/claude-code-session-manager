// Mark comment popover — handoff README §5.5: the comment box that opens beside a numbered
// mark (pin, box, element) so each mark carries its own note. Opens after one of those marks
// is created and when its number badge is clicked; the owner (MarksLayer's `popover` hook-up)
// decides when. Enter saves and closes, Shift+Enter adds a newline, Esc closes.
//
// Strict-CSP rule (DESIGN_SPEC.md "Decided changes" 3): static styles live in one constructed
// stylesheet adopted into the root node; per-mark values (left/top, badge colour) are CSSOM
// property writes through Preact's style object — never a style attribute or <style>.

import { useLayoutEffect, useEffect, useRef } from 'preact/hooks';
import { type BoxMark, type ElementMark, type PinMark, pinBox, textColorOn } from './marks';
import { colors, fonts } from './tokens';

// ── Constants (§5.5) ────────────────────────────────────────────────────────

export const POPOVER_WIDTH = 272;
export const POPOVER_SHADOW = '0 18px 44px -14px rgba(26,22,18,.55)';
/** Gap between the mark and the popover. */
export const POPOVER_GAP = 12;
/** Minimum distance from every viewport edge. */
export const POPOVER_EDGE = 12;
/** The popover's top never goes below H − 180. */
export const POPOVER_BOTTOM_RESERVE = 180;
export const COMMENT_MAX = 1000;
/** Delay before the textarea takes focus (lets the open frame settle). */
export const AUTOFOCUS_DELAY_MS = 40;

export type CommentMark = PinMark | BoxMark | ElementMark;

export const PLACEHOLDERS: Readonly<Record<CommentMark['kind'], string>> = {
  pin: "What's wrong here?",
  element: 'What about this element?',
  box: "What's going on in this area?",
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** True for marks that carry a number badge and so a comment popover. */
export function isCommentMark(m: { kind: string }): m is CommentMark {
  return m.kind === 'pin' || m.kind === 'box' || m.kind === 'element';
}

/** The mark's on-screen box: the 28 px pin for a pin, the rect for a box or element. */
export function markBBox(m: CommentMark): Rect {
  return m.kind === 'pin' ? pinBox(m.x, m.y) : { x: m.x, y: m.y, w: m.w, h: m.h };
}

/**
 * §5.5 placement: left = bbox.right + 12; if the popover would then pass W − 12, use
 * bbox.left − 284 (272 + 12) instead; then left = max(12, left).
 * top = clamp(bbox.top − 4, 12, H − 180).
 */
export function popoverPosition(bbox: Rect, W: number, H: number): { left: number; top: number } {
  let left = bbox.x + bbox.w + POPOVER_GAP;
  if (left + POPOVER_WIDTH > W - POPOVER_EDGE) left = bbox.x - POPOVER_WIDTH - POPOVER_GAP;
  left = Math.max(POPOVER_EDGE, left);
  const top = Math.max(POPOVER_EDGE, Math.min(bbox.y - 4, H - POPOVER_BOTTOM_RESERVE));
  return { left, top };
}

/** Header label: "Pin 2" / the element's selector / "Box 3". */
export function popoverLabel(m: CommentMark): string {
  if (m.kind === 'element') return m.selector;
  return `${m.kind === 'pin' ? 'Pin' : 'Box'} ${m.n ?? ''}`.trim();
}

export function commentOf(m: CommentMark): string {
  return (m as { comment?: string }).comment ?? '';
}

// ── Styles ──────────────────────────────────────────────────────────────────

export function popoverCss(): string {
  return [
    `.fw-pop{position:absolute;z-index:35;box-sizing:border-box;width:${POPOVER_WIDTH}px;display:flex;` +
      `flex-direction:column;background:${colors.paper};border:1px solid ${colors.rule};border-radius:12px;` +
      `box-shadow:${POPOVER_SHADOW};overflow:hidden}`,
    `.fw-pop-head{display:flex;align-items:center;gap:8px;padding:10px 8px 0 12px}`,
    `.fw-pop-badge{flex:none;width:22px;height:22px;border-radius:50%;font:700 11px/22px ${fonts.mono};text-align:center}`,
    `.fw-pop-label{flex:1;min-width:0;font:500 11px ${fonts.mono};color:${colors['ink-3']};overflow:hidden;` +
      `text-overflow:ellipsis;white-space:nowrap}`,
    `.fw-pop-del{flex:none;height:24px;padding:0 8px;border:0;border-radius:6px;background:transparent;` +
      `color:${colors.accent};font:600 12px ${fonts.sans};cursor:pointer}`,
    `.fw-pop-del:hover{background:${colors['paper-2']}}`,
    `.fw-pop-text{display:block;margin:8px 12px 0;box-sizing:border-box;padding:8px 10px;border:1px solid ${colors.rule};` +
      `border-radius:8px;background:${colors.field};color:${colors.ink};font:400 14px/1.45 ${fonts.sans};` +
      `outline:none;resize:none}`,
    `.fw-pop-text::placeholder{color:${colors['ink-4']}}`,
    `.fw-pop-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px 10px 12px}`,
    `.fw-pop-hint{font:400 10.5px ${fonts.mono};color:${colors['ink-4']}}`,
    `.fw-pop-save{height:28px;padding:0 12px;border-radius:7px;border:0;background:${colors.ink};color:${colors.paper};` +
      `font:600 12.5px ${fonts.sans};cursor:pointer}`,
    `.fw-pop-del:focus-visible,.fw-pop-save:focus-visible{outline:2px solid ${colors.amber};outline-offset:2px}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

export function popoverSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(popoverCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

function adoptInto(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!root || !('adoptedStyleSheets' in root) || !Array.isArray(root.adoptedStyleSheets)) return;
  const sheet = popoverSheet();
  if (!sheet || root.adoptedStyleSheets.includes(sheet)) return;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Sheet from another realm — the host adopts it instead.
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export interface PopoverProps {
  mark: CommentMark;
  /** Capture-surface size (viewport W × H). */
  W: number;
  H: number;
  /** Live comment edits (already capped at 1000 characters). */
  onComment(id: string, value: string): void;
  onDelete(id: string): void;
  /** Save / Enter / Esc — the comment is already stored, so all three just close. */
  onClose(): void;
}

export function Popover({ mark, W, H, onComment, onDelete, onClose }: PopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (rootRef.current) adoptInto(rootRef.current);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => textRef.current?.focus({ preventScroll: true }), AUTOFOCUS_DELAY_MS);
    return () => clearTimeout(t);
  }, [mark.id]);

  const { left, top } = popoverPosition(markBBox(mark), W, H);
  const value = commentOf(mark);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={rootRef}
      class="fw-pop"
      data-part="popover"
      data-popover-for={mark.id}
      role="dialog"
      aria-label={`Comment on ${popoverLabel(mark)}`}
      style={{ left: `${left}px`, top: `${top}px` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="fw-pop-head">
        <span
          class="fw-pop-badge"
          data-part="popover-badge"
          style={{ background: mark.color, color: textColorOn(mark.color) }}
        >
          {mark.n ?? ''}
        </span>
        <span class="fw-pop-label" data-part="popover-label">
          {popoverLabel(mark)}
        </span>
        <button type="button" class="fw-pop-del" data-part="popover-delete" onClick={() => onDelete(mark.id)}>
          Delete
        </button>
      </div>
      <textarea
        ref={textRef}
        class="fw-pop-text"
        data-part="popover-text"
        rows={2}
        maxLength={COMMENT_MAX}
        placeholder={PLACEHOLDERS[mark.kind]}
        aria-label="Comment"
        value={value}
        onInput={(e) => {
          const el = e.currentTarget as HTMLTextAreaElement;
          const v = el.value.slice(0, COMMENT_MAX);
          if (v !== el.value) el.value = v;
          onComment(mark.id, v);
        }}
        onKeyDown={onKeyDown}
      />
      <div class="fw-pop-foot">
        <span class="fw-pop-hint">↵ save · esc close</span>
        <button type="button" class="fw-pop-save" data-part="popover-save" onClick={() => onClose()}>
          Save
        </button>
      </div>
    </div>
  );
}
