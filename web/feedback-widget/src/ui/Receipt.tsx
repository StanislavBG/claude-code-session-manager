// Receipt — the `receipt` success variant of handoff README §5.7. It replaces the panel's
// contents in place once a send lands (mode `sent`): a green check + "RECEIVED · {id}", a
// thank-you headline, dotted-leader summary rows, and Send another / Done.
//
// When the server returned no id (§1 Submission: "If no id comes back, hide the id text"),
// every id text is dropped: the eyebrow reads "RECEIVED" and the body keeps only the closing
// sentence.
//
// Strict-CSP rule (tokens.ts): no `style` attribute, no <style> element — the rules below are
// folded into the panel's one constructed stylesheet (Panel.tsx → panelCss()).
//
// The bottom of this file holds the other two §5.7 variants' parts: the `toast` card and the
// `fold` ping bubble + shrink animation (App.tsx owns their timers and the delayed POST).

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { FeedbackUser } from '../host';
import { anchorClass, CHECK_PATH, launcherSheet, type LauncherVariant } from './Launcher';
import { adoptInto } from './shared';
import { colors, fonts, motion } from './tokens';

// ── Copy (§5.7) ───────────────────────────────────────────────────────────────

export const RECEIVED = 'Received';
export const SEND_ANOTHER_LABEL = 'Send another';
export const DONE_LABEL = 'Done';
export const NOT_SENT = 'not sent';

/** First word of the reporter's display name; null when there is no named reporter. */
export function firstName(user: FeedbackUser | null | undefined): string | null {
  const name = user?.name?.trim();
  if (!name) return null;
  return name.split(/\s+/)[0] || null;
}

/** "RECEIVED · {id}", or just "RECEIVED" with no id (text-transform does the casing). */
export function receivedLabel(id: string | null | undefined): string {
  return id ? `${RECEIVED} · ${id}` : RECEIVED;
}

export function receiptHeadline(user: FeedbackUser | null | undefined): string {
  const first = firstName(user);
  return first ? `Thanks, ${first} — it's with the team.` : "Thanks — it's with the team.";
}

export function receiptBody(id: string | null | undefined): string {
  return id ? `Quote ${id} if you follow up. Nothing else to do.` : 'Nothing else to do.';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Screenshot row: "1280×800 · 4 marks". */
export function receiptScreenshot(width: number, height: number, marks: number): string {
  return `${Math.round(width)}×${Math.round(height)} · ${plural(marks, 'mark')}`;
}

export function receiptConsole(count: number, on: boolean): string {
  return on ? plural(count, 'error') : NOT_SENT;
}

export function receiptNetwork(count: number, on: boolean): string {
  return on ? plural(count, 'failed request') : NOT_SENT;
}

/** "From" row: the reporter's name (or email/id), else "Anonymous". */
export function receiptFrom(user: FeedbackUser | null | undefined): string {
  const who = user ? (user.name || user.email || user.id || '').trim() : '';
  return who || 'Anonymous';
}

// ── Styles ────────────────────────────────────────────────────────────────────

export function receiptCss(): string {
  const c = colors;
  const ease = motion.ease;
  return [
    `.fw-rc{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column}`,
    `.fw-rc-top{display:flex;flex-direction:column;gap:12px;padding:24px 22px 18px;border-bottom:1px dashed ${c['ink-4']}}`,
    `.fw-rc-eyerow{display:flex;align-items:center;gap:10px}`,
    `.fw-rc-check{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;` +
      `background:${c.green};color:${c.paper}}`,
    `.fw-rc-check svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}`,
    `.fw-rc-eyebrow{font-family:${fonts.mono};font-weight:500;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${c.green}}`,
    `.fw-rc-headline{font-family:${fonts.serif};font-weight:600;font-size:24px;line-height:1.2;color:${c.ink}}`,
    `.fw-rc-body{font-weight:400;font-size:14px;line-height:1.5;color:${c['ink-3']}}`,
    `.fw-rc-rows{display:flex;flex-direction:column;padding:12px 22px 4px}`,
    `.fw-rc-row{display:flex;align-items:baseline;gap:8px;padding:6px 0;font-family:${fonts.mono};font-weight:400;font-size:12px;line-height:1.4}`,
    `.fw-rc-k{flex:none;color:${c['ink-3']}}`,
    `.fw-rc-leader{flex:1 1 auto;min-width:12px;border-bottom:1px dotted ${c['ink-4']};transform:translateY(-3px)}`,
    `.fw-rc-v{flex:0 1 auto;min-width:0;max-width:62%;color:${c.ink};text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.fw-rc-actions{margin-top:auto;display:flex;gap:8px;padding:16px 22px 20px}`,
    `.fw-rc-btn{flex:1;height:40px;border-radius:9px;font-weight:600;font-size:14px;transition:background-color 200ms ${ease}}`,
    `.fw-rc-again{border:1px solid ${c.rule};background:transparent;color:${c.ink}}`,
    `.fw-rc-again:hover{background:${c['paper-2']}}`,
    `.fw-rc-done{border:0;background:${c.ink};color:${c.paper}}`,
    `.fw-rc-done:hover{background:${c['ink-2']}}`,
  ].join('\n');
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface ReceiptProps {
  /** Report id from the server's `{ "id": … }`; null/absent → every id text is hidden. */
  id?: string | null;
  user?: FeedbackUser | null;
  /** Type label as shown in the panel's segmented control ("Bug", "Feature request", "Other"). */
  typeLabel: string;
  title: string;
  screenshot: { width: number; height: number; marks: number };
  console: { count: number; on: boolean };
  network: { count: number; on: boolean };
  onSendAnother: () => void;
  onDone: () => void;
}

export function Receipt(props: ReceiptProps) {
  const { id = null, user = null } = props;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Type', props.typeLabel],
    ['Title', props.title.trim() || '—'],
    ['Screenshot', receiptScreenshot(props.screenshot.width, props.screenshot.height, props.screenshot.marks)],
    ['Console', receiptConsole(props.console.count, props.console.on)],
    ['Network', receiptNetwork(props.network.count, props.network.on)],
    ['From', receiptFrom(user)],
  ];
  return (
    <div class="fw-rc" data-part="receipt" role="status">
      <div class="fw-rc-top">
        <div class="fw-rc-eyerow">
          <span class="fw-rc-check" data-part="check" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <span class="fw-rc-eyebrow" data-part="received">
            {receivedLabel(id)}
          </span>
        </div>
        <h2 class="fw-rc-headline" data-part="headline">
          {receiptHeadline(user)}
        </h2>
        <p class="fw-rc-body" data-part="body">
          {receiptBody(id)}
        </p>
      </div>
      <div class="fw-rc-rows">
        {rows.map(([k, v]) => (
          <div key={k} class="fw-rc-row" data-row={k}>
            <span class="fw-rc-k">{k}</span>
            <span class="fw-rc-leader" aria-hidden="true" />
            <span class="fw-rc-v" title={v}>
              {v}
            </span>
          </div>
        ))}
      </div>
      <div class="fw-rc-actions">
        <button type="button" class="fw-rc-btn fw-rc-again" data-part="send-another" onClick={props.onSendAnother}>
          {SEND_ANOTHER_LABEL}
        </button>
        <button type="button" class="fw-rc-btn fw-rc-done" data-part="done" onClick={props.onDone}>
          {DONE_LABEL}
        </button>
      </div>
    </div>
  );
}

// ── Toast + fold ping bubble (§5.7 "Toast", "Fold") ──────────────────────────
//
// Neither sits inside the panel (the widget is back in `idle` when they show), so their rules
// live in their own constructed sheet, adopted next to the launcher sheet that carries the
// §5.7 anchor classes.

/** Toast variant: the POST waits this long so Undo can cancel it locally (§1 Submission). */
export const TOAST_SEND_DELAY_MS = 6000;
/** Toast auto-dismiss (§5.7: "auto-dismiss at 6.2 s"). */
export const TOAST_DISMISS_MS = 6200;
/** Fold: the panel's shrink into the launcher (§5.7). */
export const FOLD_ANIM_MS = 450;
export const FOLD_EASE = 'cubic-bezier(.5,0,.75,0)';
export const FOLD_SCALE = '.06';

export const TOAST_TITLE = 'Feedback sent';
export const UNDO_LABEL = 'Undo';

/** "{id} · thanks, {firstName}"; the id text is dropped while none is known (§1 Submission). */
export function toastLine(id: string | null | undefined, user: FeedbackUser | null | undefined): string {
  const first = firstName(user);
  const thanks = first ? `thanks, ${first}` : 'thanks';
  return id ? `${id} · ${thanks}` : thanks;
}

export function successCss(): string {
  const c = colors;
  const ease = motion.ease;
  return [
    `.fw-toast{z-index:41;box-sizing:border-box;width:320px;border-radius:12px;overflow:hidden;background:${c.ink};color:${c.paper};` +
      `box-shadow:0 16px 40px -12px rgba(26,22,18,.65);pointer-events:auto;font-family:${fonts.sans}}`,
    `.fw-toast-row{display:flex;align-items:center;gap:12px;padding:12px 10px 12px 14px}`,
    `.fw-toast-check{flex:none;display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:999px;` +
      `background:${c.green};color:${c.paper}}`,
    `.fw-toast-check svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}`,
    `.fw-toast-text{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}`,
    `.fw-toast-title{font-weight:600;font-size:14px;line-height:1.3}`,
    `.fw-toast-line{font-family:${fonts.mono};font-weight:400;font-size:11px;line-height:1.3;color:${c['rule-strong']};` +
      `overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `.fw-toast-undo{flex:none;height:30px;padding:0 10px;border:0;margin:0;border-radius:8px;background:transparent;color:${c.amber};` +
      `font-family:${fonts.sans};font-weight:600;font-size:13px;cursor:pointer;transition:background-color 150ms ${ease}}`,
    `.fw-toast-undo:hover{background:rgba(245,240,230,.1)}`,
    `.fw-toast-undo:focus-visible{outline:2px solid ${c.amber};outline-offset:2px}`,
    `.fw-toast-track{height:3px;background:rgba(245,240,230,.1)}`,
    `.fw-toast-fill{height:100%;background:${c.amber};transform-origin:left center;` +
      `animation:fw-toast-count ${TOAST_SEND_DELAY_MS}ms linear forwards}`,
    `@keyframes fw-toast-count{from{transform:scaleX(1)}to{transform:scaleX(0)}}`,
    `.fw-ping-bubble{z-index:41;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 14px;` +
      `border-radius:10px;background:${c.green};color:${c.paper};font-family:${fonts.sans};font-weight:600;font-size:13px;` +
      `white-space:nowrap;pointer-events:none}`,
    `.fw-ping-id{font-family:${fonts.mono};font-weight:500;font-size:11.5px;color:${c['green-text']}}`,
  ].join('\n');
}

let successSheetCache: CSSStyleSheet | null = null;

/** The one constructed toast / ping-bubble sheet (null where constructable sheets are unavailable). */
export function successSheet(): CSSStyleSheet | null {
  if (successSheetCache) return successSheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(successCss());
    successSheetCache = sheet;
  } catch {
    return null;
  }
  return successSheetCache;
}

function useSuccessSheets<T extends Element>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    adoptInto(ref.current, [launcherSheet(), successSheet()]);
  }, []);
  return ref;
}

export interface ToastProps {
  /** Server id once the delayed POST has landed; null before (the id text is hidden). */
  id?: string | null;
  user?: FeedbackUser | null;
  variant?: LauncherVariant;
  onUndo: () => void;
}

/** §5.7 Toast: 320 px ink card, check + "Feedback sent" + id line + Undo, 6 s countdown bar. */
export function Toast({ id = null, user = null, variant = 'corner', onUndo }: ToastProps) {
  const ref = useSuccessSheets<HTMLDivElement>();
  return (
    <div ref={ref} class={`fw-toast ${anchorClass(variant)}`} data-part="toast" role="status">
      <div class="fw-toast-row">
        <span class="fw-toast-check" data-part="toast-check" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d={CHECK_PATH} />
          </svg>
        </span>
        <span class="fw-toast-text">
          <span class="fw-toast-title" data-part="toast-title">
            {TOAST_TITLE}
          </span>
          <span class="fw-toast-line" data-part="toast-line">
            {toastLine(id, user)}
          </span>
        </span>
        <button type="button" class="fw-toast-undo" data-part="undo" onClick={onUndo}>
          {UNDO_LABEL}
        </button>
      </div>
      <div class="fw-toast-track" aria-hidden="true">
        <div class="fw-toast-fill" data-part="countdown" />
      </div>
    </div>
  );
}

export interface PingBubbleProps {
  id?: string | null;
  variant?: LauncherVariant;
}

/** §5.7 Fold: "Sent {id} — thank you" beside the pinging launcher (id hidden when absent). */
export function PingBubble({ id = null, variant = 'corner' }: PingBubbleProps) {
  const ref = useSuccessSheets<HTMLDivElement>();
  return (
    <div ref={ref} class={`fw-ping-bubble ${anchorClass(variant)}`} data-part="ping-bubble" role="status">
      {id ? (
        <>
          Sent <span class="fw-ping-id">{id}</span> — thank you
        </>
      ) : (
        'Sent — thank you'
      )}
    </div>
  );
}

/**
 * §5.7 Fold: shrinks `panel` to scale(.06) + opacity 0 over 450 ms with its transform-origin at
 * the centre of `target` (the launcher). Web Animations, not a style attribute (strict CSP).
 * Returns the animation, or null where element.animate is unavailable.
 */
export function foldInto(panel: Element, target: { x: number; y: number }): Animation | null {
  if (typeof (panel as HTMLElement).animate !== 'function') return null;
  const r = panel.getBoundingClientRect();
  const origin = `${Math.round(target.x - r.left)}px ${Math.round(target.y - r.top)}px`;
  return (panel as HTMLElement).animate(
    [
      { transformOrigin: origin, transform: 'scale(1)', opacity: 1 },
      { transformOrigin: origin, transform: `scale(${FOLD_SCALE})`, opacity: 0 },
    ],
    { duration: FOLD_ANIM_MS, easing: FOLD_EASE, fill: 'forwards' },
  );
}

/** Centre of the launcher (or, with no launcher, the §5.7 hidden anchor: 20 px from bottom-right). */
export function foldTarget(launcher: Element | null): { x: number; y: number } {
  if (launcher) {
    const r = launcher.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: window.innerWidth - 20, y: window.innerHeight - 20 };
}
