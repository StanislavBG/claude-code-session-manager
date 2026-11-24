// Discard dialog — handoff README §5.8, shown only while the machine's `confirm` flag is up
// (§2: close × / Esc with marks or text → confirm; Keep editing · Esc → closes; Discard → idle,
// everything reset). ARIA per §4: role="dialog" aria-modal="true".
//
// Strict-CSP rule (tokens.ts): styles live in one constructed stylesheet adopted on the
// dialog's own root (the widget's shadow root) — never a `style` attribute or <style>.

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { Event, State } from './machine';
import { colors, fonts, motion } from './tokens';

export const DISCARD_TITLE = 'Discard this feedback?';
const TITLE_ID = 'fw-discard-title';

/** §5.8 body copy; the "what you have written" clause only when text was entered. */
export function discardBody(marks: number, hasText: boolean): string {
  const noun = marks === 1 ? 'mark' : 'marks';
  return `You will lose ${marks} ${noun}${hasText ? ' and what you have written.' : '.'}`;
}

/** Text of the dialog sheet (§5.8). Sits above every other widget layer except the flash. */
export function discardCss(): string {
  const ease = motion.ease;
  return [
    `.fw-discard-scrim{position:fixed;inset:0;z-index:60;background:rgba(26,22,18,.38);display:flex;` +
      `align-items:center;justify-content:center;pointer-events:auto}`,
    `.fw-discard-card{width:360px;max-width:calc(100% - 32px);padding:22px 22px 18px;display:flex;` +
      `flex-direction:column;gap:8px;background:${colors.paper};border:1px solid ${colors.rule};` +
      `border-radius:14px;box-shadow:0 24px 60px -18px rgba(26,22,18,.6)}`,
    `.fw-discard-title{font-family:${fonts.serif};font-weight:600;font-size:20px;line-height:1.25;color:${colors.ink}}`,
    `.fw-discard-body{font-family:${fonts.sans};font-weight:400;font-size:14px;line-height:1.5;color:${colors['ink-3']}}`,
    `.fw-discard-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}`,
    `.fw-discard-btn{height:38px;padding:0 14px;border-radius:9px;font-family:${fonts.sans};` +
      `font-weight:600;font-size:13.5px;cursor:pointer;transition:background-color 150ms ${ease}}`,
    `.fw-discard-btn:focus-visible{outline:2px solid ${colors.amber};outline-offset:2px}`,
    `.fw-discard-keep{border:1px solid ${colors.rule};background:transparent;color:${colors.ink}}`,
    `.fw-discard-keep:hover{background:${colors['paper-2']}}`,
    `.fw-discard-go{border:0;background:${colors.accent};color:${colors['on-accent']}}`,
    `.fw-discard-go:hover{background:${colors['accent-hover']}}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

/** The one constructed dialog sheet (null where constructable sheets are unavailable). */
export function discardSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(discardCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

function adoptOn(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  const sheet = discardSheet();
  if (!sheet || !root || !('adoptedStyleSheets' in root) || !Array.isArray(root.adoptedStyleSheets)) return;
  if (root.adoptedStyleSheets.includes(sheet)) return;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Sheet from another realm — leave the root unstyled rather than throw.
  }
}

export interface DiscardDialogProps {
  state: State;
  dispatch: (e: Event) => void;
}

export function DiscardDialog({ state, dispatch }: DiscardDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const open = state.confirm;

  useLayoutEffect(() => {
    if (!open) return;
    if (scrimRef.current) adoptOn(scrimRef.current);
    keepRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const hasText = state.draft.title.trim() !== '' || state.draft.body.trim() !== '';
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // §3: the dialog is first in the Esc chain — close it and stop here so no outer
    // handler turns the same key press into a second close request.
    e.preventDefault();
    e.stopPropagation();
    dispatch({ type: 'keepEditing' });
  };

  return (
    <div ref={scrimRef} class="fw-discard-scrim" onKeyDown={onKeyDown}>
      <div class="fw-discard-card" role="dialog" aria-modal="true" aria-labelledby={TITLE_ID}>
        <span id={TITLE_ID} class="fw-discard-title">
          {DISCARD_TITLE}
        </span>
        <span class="fw-discard-body">{discardBody(state.marks.length, hasText)}</span>
        <div class="fw-discard-actions">
          <button
            ref={keepRef}
            type="button"
            class="fw-discard-btn fw-discard-keep"
            onClick={() => dispatch({ type: 'keepEditing' })}
          >
            Keep editing
          </button>
          <button type="button" class="fw-discard-btn fw-discard-go" onClick={() => dispatch({ type: 'discard' })}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}
