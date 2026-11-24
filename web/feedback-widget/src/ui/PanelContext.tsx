// Panel body sections "Marks on screenshot" and "Attached automatically" — handoff README §5.6
// (flows annotate & docked), plus the §5.6 "Switch". Rendered by the caller as <Panel>'s
// children, below Details, so the reporter sees and controls exactly what a report carries.
//
// The component is controlled: marks, notes, the console/network buffers and the two switches
// are owned by the caller. The switches feed ReportState.switches, which buildReport() turns
// into `console: null` / `network: null` when off.
//
// Strict-CSP rule (tokens.ts): every style lives in one constructed stylesheet; the only
// per-render style writes are the badge colours, through the CSSOM (never a `style` attribute).

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ConsoleEntry, NetworkEntry } from '../buffers';
import { NOTE_MAX } from '../report';
import { isNumbered, textColorOn, type Mark } from './marks';
import { adoptInto } from './shared';
import { colors, fonts, motion } from './tokens';

// ── Copy (§5.6) ───────────────────────────────────────────────────────────────

export const MARKS_LABEL = 'Marks on screenshot';
export const ATTACHED_LABEL = 'Attached automatically';
export const MARKS_EMPTY = 'No marks yet. Point at what you mean with the toolbar — or skip it.';
export const NOTE_PLACEHOLDER = 'Add a note (optional)';
export const ALWAYS = 'ALWAYS';
export const CONSOLE_OFF = 'Console errors — not sent';
export const NETWORK_OFF = 'Failed requests — not sent';

/** "1 mark" / "3 marks" (singular only for exactly one). */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Count on the right of the Marks label: "3 marks" / "none yet". */
export function marksCount(marks: readonly Mark[]): string {
  return marks.length ? plural(marks.length, 'mark') : 'none yet';
}

/** Kind label of a numbered row: "Pin" / "Box" / "Element · button.book". */
export function kindLabel(m: Mark): string {
  if (m.kind === 'pin') return 'Pin';
  if (m.kind === 'box') return 'Box';
  if (m.kind === 'element') return `Element · ${m.selector}`;
  return m.kind;
}

/** The unnumbered-marks line: "+ 1 drawing · 1 arrow · 1 label", or '' when there are none. */
export function unnumberedSummary(marks: readonly Mark[]): string {
  let draw = 0;
  let arrow = 0;
  let text = 0;
  for (const m of marks) {
    if (m.kind === 'draw') draw++;
    else if (m.kind === 'arrow') arrow++;
    else if (m.kind === 'text') text++;
  }
  const parts = [draw && plural(draw, 'drawing'), arrow && plural(arrow, 'arrow'), text && plural(text, 'label')].filter(
    Boolean,
  );
  return parts.length ? `+ ${parts.join(' · ')}` : '';
}

/** Screenshot row: "{W} × {H} · {n} marks". */
export function screenshotLabel(width: number, height: number, marks: number): string {
  return `${Math.round(width)} × ${Math.round(height)} · ${plural(marks, 'mark')}`;
}

export function consoleLabel(n: number, on: boolean): string {
  return on ? plural(n, 'console error') : CONSOLE_OFF;
}

export function networkLabel(n: number, on: boolean): string {
  return on ? plural(n, 'failed request') : NETWORK_OFF;
}

export interface ListItem {
  msg: string;
  src: string;
}

/** Console list item: the message (×count when repeated) and its 'file:line:col' source. */
export function consoleItem(e: ConsoleEntry): ListItem {
  return { msg: e.count > 1 ? `${e.message} ×${e.count}` : e.message, src: e.source };
}

/** Network list item: "POST /api/x → 502", source = duration in seconds. */
export function networkItem(e: NetworkEntry): ListItem {
  return { msg: `${e.method} ${e.url} → ${e.status}`, src: `${(Math.max(0, e.durationMs) / 1000).toFixed(2)}s` };
}

function noteOf(m: Mark): string {
  return (m as { comment?: string }).comment ?? '';
}

// ── Styles ────────────────────────────────────────────────────────────────────

export function panelContextCss(): string {
  const c = colors;
  const ease = motion.ease;
  return [
    `.fw-pc{display:flex;flex-direction:column;gap:16px}`,
    `.fw-pc-section{display:flex;flex-direction:column;gap:6px}`,
    `.fw-pc-labelrow{display:flex;align-items:baseline;justify-content:space-between}`,
    `.fw-pc-label{font-family:${fonts.mono};font-weight:500;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:${c['ink-3']}}`,
    `.fw-pc-count{font-family:${fonts.mono};font-size:11px;color:${c['ink-4']}}`,
    `.fw-pc-empty{border:1px dashed ${c['rule-strong']};border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5;color:${c['ink-3']}}`,
    `.fw-pc-row{display:grid;grid-template-columns:24px 1fr 26px;gap:10px;align-items:center;padding:8px;margin:0 -8px;border-radius:9px}`,
    `.fw-pc-row:hover{background:${c['paper-3']}}`,
    `.fw-pc-badge{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;border:2px solid #fff;` +
      `font-family:${fonts.mono};font-weight:700;font-size:11px}`,
    `.fw-pc-main{min-width:0;display:flex;flex-direction:column;gap:2px}`,
    `.fw-pc-kind{font-family:${fonts.mono};font-weight:500;font-size:11px;color:${c['ink-3']};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.fw-pc-note{width:100%;border:0;background:transparent;outline:none;font-size:14px;color:${c.ink}}`,
    `.fw-pc-note::placeholder{color:${c['ink-4']}}`,
    `.fw-pc-remove{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;color:${c['ink-4']}}`,
    `.fw-pc-remove:hover{background:${c['paper-3']}}`,
    `.fw-pc-remove svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`,
    `.fw-pc-extra{font-family:${fonts.mono};font-size:11.5px;color:${c['ink-3']};padding-left:34px}`,
    `.fw-pc-arow{display:grid;grid-template-columns:78px minmax(0,1fr) auto;gap:10px;align-items:center;padding:9px 0;border-top:1px dashed ${c.rule}}`,
    `.fw-pc-key{font-weight:500;font-size:12.5px;color:${c['ink-3']}}`,
    `.fw-pc-val{min-width:0;display:flex;align-items:center;gap:8px;font-size:13px;color:${c.ink}}`,
    `.fw-pc-val--off{color:${c['ink-4']}}`,
    `.fw-pc-url{font-family:${fonts.mono};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.fw-pc-always{font-family:${fonts.mono};font-size:10px;color:${c['ink-4']}}`,
    `.fw-pc-view{font-weight:600;font-size:12px;color:${c.accent}}`,
    `.fw-pc-list{display:flex;flex-direction:column;gap:8px;margin:0 0 10px;padding:10px 12px;border-radius:8px;background:${c.ink};` +
      `font-family:${fonts.mono};font-weight:400;font-size:11px;line-height:1.5}`,
    `.fw-pc-item{display:flex;flex-direction:column;gap:1px}`,
    `.fw-pc-msg{color:${c.amber};overflow-wrap:anywhere}`,
    `.fw-pc-src{color:${c['rule-strong']}}`,
    // §5.6 Switch
    `.fw-pc-switch{position:relative;flex:none;width:30px;height:18px;border-radius:9px;background:${c['rule-strong']};transition:background-color 200ms ${ease}}`,
    `.fw-pc-switch[aria-checked="true"]{background:${c.green}}`,
    `.fw-pc-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:${c.field};` +
      `box-shadow:0 1px 2px rgba(26,22,18,.3);transition:transform 200ms ${ease}}`,
    `.fw-pc-switch[aria-checked="true"] .fw-pc-knob{transform:translateX(12px)}`,
    `@media (prefers-reduced-motion:reduce){.fw-pc-switch,.fw-pc-knob{transition:none}}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

export function panelContextSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(panelContextCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

// ── Components ────────────────────────────────────────────────────────────────

export type SwitchName = 'console' | 'network';

export interface PanelContextProps {
  /** Every mark, in creation order (numbered ones carry `n`). */
  marks: readonly Mark[];
  /** A row's note edited (already capped at 1000 characters). */
  onNote(id: string, note: string): void;
  onRemove(id: string): void;
  /** Row hover → highlight that mark on the page (MarksLayer `hoveredId`); null on leave. */
  onHover?(id: string | null): void;
  /** Captured screenshot size (CSS px). */
  screenshot: { width: number; height: number };
  /** Page URL captured at open. */
  pageUrl: string;
  console: readonly ConsoleEntry[];
  network: readonly NetworkEntry[];
  /** ReportState.switches — off ⇒ the report's console/network is null. */
  switches: { console: boolean; network: boolean };
  onSwitch(name: SwitchName, on: boolean): void;
  /** All inputs disabled (while sending). */
  disabled?: boolean;
}

function Badge({ mark }: { mark: Mark }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.background = mark.color;
    el.style.color = textColorOn(mark.color);
  }, [mark.color]);
  return (
    <span ref={ref} class="fw-pc-badge" data-part="badge" aria-hidden="true">
      {mark.n ?? ''}
    </span>
  );
}

function Switch(props: { name: SwitchName; label: string; on: boolean; disabled?: boolean; onToggle(on: boolean): void }) {
  return (
    <button
      type="button"
      role="switch"
      class="fw-pc-switch"
      data-switch={props.name}
      aria-checked={props.on ? 'true' : 'false'}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onToggle(!props.on)}
    >
      <span class="fw-pc-knob" aria-hidden="true" />
    </button>
  );
}

function ListRow(props: {
  name: SwitchName;
  keyLabel: string;
  label: string;
  switchLabel: string;
  on: boolean;
  items: ListItem[];
  disabled?: boolean;
  onToggle(on: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open && props.on && props.items.length > 0;
  const listId = `fw-pc-list-${props.name}`;
  return (
    <div data-row={props.name}>
      <div class="fw-pc-arow">
        <span class="fw-pc-key">{props.keyLabel}</span>
        <span class={`fw-pc-val${props.on ? '' : ' fw-pc-val--off'}`}>
          <span data-part="value">{props.label}</span>
          {props.on && props.items.length > 0 && (
            <button
              type="button"
              class="fw-pc-view"
              data-part="view"
              aria-expanded={expanded ? 'true' : 'false'}
              aria-controls={listId}
              onClick={() => setOpen(!open)}
            >
              {expanded ? 'hide' : 'view'}
            </button>
          )}
        </span>
        <Switch name={props.name} label={props.switchLabel} on={props.on} disabled={props.disabled} onToggle={props.onToggle} />
      </div>
      {expanded && (
        <div id={listId} class="fw-pc-list" data-part="list">
          {props.items.map((it, i) => (
            <div key={i} class="fw-pc-item">
              <span class="fw-pc-msg">{it.msg}</span>
              {it.src && <span class="fw-pc-src">{it.src}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PanelContext(props: PanelContextProps) {
  const { marks, disabled } = props;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) adoptInto(ref.current, panelContextSheet());
  }, []);

  const numbered = marks.filter(isNumbered);
  const extra = unnumberedSummary(marks);
  const hover = (id: string | null) => props.onHover?.(id);

  return (
    <div ref={ref} class="fw-pc" data-part="context">
      <div class="fw-pc-section" data-section="marks">
        <div class="fw-pc-labelrow">
          <span class="fw-pc-label">{MARKS_LABEL}</span>
          <span class="fw-pc-count" data-part="marks-count">
            {marksCount(marks)}
          </span>
        </div>
        {marks.length === 0 ? (
          <div class="fw-pc-empty" data-part="marks-empty">
            {MARKS_EMPTY}
          </div>
        ) : (
          <div>
            {numbered.map((m) => (
              <div
                key={m.id}
                class="fw-pc-row"
                data-mark={m.id}
                onMouseEnter={() => hover(m.id)}
                onMouseLeave={() => hover(null)}
              >
                <Badge mark={m} />
                <div class="fw-pc-main">
                  <span class="fw-pc-kind" data-part="kind">
                    {kindLabel(m)}
                  </span>
                  <input
                    class="fw-pc-note"
                    type="text"
                    data-part="note"
                    aria-label={`Note for ${kindLabel(m)} ${m.n ?? ''}`.trim()}
                    placeholder={NOTE_PLACEHOLDER}
                    maxLength={NOTE_MAX}
                    value={noteOf(m)}
                    disabled={disabled}
                    onInput={(e) => props.onNote(m.id, (e.currentTarget as HTMLInputElement).value.slice(0, NOTE_MAX))}
                  />
                </div>
                <button
                  type="button"
                  class="fw-pc-remove"
                  data-part="remove"
                  aria-label={`Remove mark ${m.n ?? ''}`.trim()}
                  disabled={disabled}
                  onClick={() => {
                    hover(null);
                    props.onRemove(m.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
            {extra && (
              <div class="fw-pc-extra" data-part="marks-extra">
                {extra}
              </div>
            )}
          </div>
        )}
      </div>

      <div class="fw-pc-section" data-section="attached">
        <span class="fw-pc-label">{ATTACHED_LABEL}</span>
        <div>
          <div class="fw-pc-arow" data-row="screenshot">
            <span class="fw-pc-key">Screenshot</span>
            <span class="fw-pc-val" data-part="value">
              {screenshotLabel(props.screenshot.width, props.screenshot.height, marks.length)}
            </span>
            <span class="fw-pc-always">{ALWAYS}</span>
          </div>
          <div class="fw-pc-arow" data-row="page">
            <span class="fw-pc-key">Page</span>
            <span class="fw-pc-val fw-pc-url" data-part="value" title={props.pageUrl}>
              {props.pageUrl}
            </span>
            <span class="fw-pc-always">{ALWAYS}</span>
          </div>
          <ListRow
            name="console"
            keyLabel="Console"
            label={consoleLabel(props.console.length, props.switches.console)}
            switchLabel="Send console errors"
            on={props.switches.console}
            items={props.console.map(consoleItem)}
            disabled={disabled}
            onToggle={(on) => props.onSwitch('console', on)}
          />
          <ListRow
            name="network"
            keyLabel="Network"
            label={networkLabel(props.network.length, props.switches.network)}
            switchLabel="Send failed requests"
            on={props.switches.network}
            items={props.network.map(networkItem)}
            disabled={disabled}
            onToggle={(on) => props.onSwitch('network', on)}
          />
        </div>
      </div>
    </div>
  );
}
