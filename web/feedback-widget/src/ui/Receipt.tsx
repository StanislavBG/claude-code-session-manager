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

import type { FeedbackUser } from '../host';
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
