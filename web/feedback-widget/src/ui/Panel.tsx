// Panel, flow `annotate` — the corner card of handoff README §5.6: Container, Geometry
// "annotate — corner card", Header, Body (Type · Title · Details) and Footer (reporter + Send
// with upload progress). Visibility from §2 (machine.panelVisible); the Send/Esc/⌘↵ semantics
// stay in the machine — this component only dispatches.
//
// The "Marks on screenshot" and "Attached automatically" sections are rendered by the caller
// through `children` (they slot in below Details).
//
// Strict-CSP rule (tokens.ts): every static style lives in one constructed stylesheet adopted on
// the panel's own root; the only per-render style write is the progress bar width, through the
// CSSOM — never a `style` attribute or a <style> element.

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { FeedbackUser } from '../host';
import type { ReportType } from '../report';
import { panelVisible, type Event, type State } from './machine';
import { colors, fonts, motion } from './tokens';

// ── Copy & rules (§5.6) ───────────────────────────────────────────────────────

export const EYEBROW = 'Step 2 of 2 · Describe';
export const HEADLINE = 'Describe what you marked';
export const BACK_LABEL = '← Marks';
export const TITLE_ERROR = 'Add a short title so the team can find this.';
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const DETAILS_MAX = 5000;
export const DETAILS_ROWS = 4;
/** Describe → Title focus delay (§2). */
export const FOCUS_TITLE_DELAY_MS = 420;

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
    `.fw-pn-progress{position:absolute;top:0;left:0;height:3px;width:0;background:${c.accent};z-index:1;transition:width 200ms ${ease}}`,
    // Header
    `.fw-pn-head{flex:none;display:flex;flex-direction:column;gap:6px;padding:16px 12px 14px 20px;border-bottom:1px solid ${c.rule}}`,
    `.fw-pn-headrow{display:flex;align-items:center;gap:6px}`,
    `.fw-pn-eyebrow{flex:1;min-width:0;font-family:${fonts.mono};font-weight:500;font-size:10.5px;line-height:1.3;letter-spacing:.1em;` +
      `text-transform:uppercase;color:${c.accent};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.fw-pn-headline{font-family:${fonts.serif};font-weight:600;font-size:22px;line-height:1.2;color:${c.ink}}`,
    `.fw-pn-back{height:30px;padding:0 10px;border-radius:7px;border:1px solid ${c.rule};font-weight:600;font-size:12.5px;color:${c['ink-2']}}`,
    `.fw-pn-back:hover{background:${c['paper-2']}}`,
    `.fw-pn-close{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:7px;color:${c['ink-3']}}`,
    `.fw-pn-close:hover{background:${c['paper-3']}}`,
    `.fw-pn-close svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`,
    // Body
    `.fw-pn-body{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:16px;padding:16px 20px 18px}`,
    `.fw-pn-field{display:flex;flex-direction:column;gap:6px}`,
    `.fw-pn-labelrow{display:flex;align-items:baseline;justify-content:space-between}`,
    `.fw-pn-label{font-family:${fonts.mono};font-weight:500;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:${c['ink-3']}}`,
    `.fw-pn-opt{font-family:${fonts.mono};font-size:11px;color:${c['ink-4']}}`,
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
    // §4 reduced motion: no translate/scale, fades capped at 150 ms.
    `@media (prefers-reduced-motion:reduce){` +
      `.fw-panel{transition:opacity 150ms, visibility 150ms}` +
      `.fw-panel--hidden{transform:none}}`,
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

function adoptInto(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  if (!root || !('adoptedStyleSheets' in root) || !Array.isArray(root.adoptedStyleSheets)) return;
  const sheet = panelSheet();
  if (!sheet || root.adoptedStyleSheets.includes(sheet)) return;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  } catch {
    // Sheet from another document/realm — the host mounts it instead.
  }
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
  /** Launcher variant `mini` puts the card bottom-left. */
  mini?: boolean;
  /** Override for the shortcut chip platform test (defaults to navigator.platform). */
  platform?: string;
  /** Marks / Attached sections (rendered below Details). */
  children?: ComponentChildren;
}

export function Panel(props: PanelProps) {
  const { state, dispatch, progress = 0, user = null, mini = false } = props;
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [ownType, setOwnType] = useState<{ session: number; type: ReportType }>({ session: state.session, type: DEFAULT_TYPE });
  const type = props.reportType ?? (ownType.session === state.session ? ownType.type : DEFAULT_TYPE);
  const spec = TYPES.find((t) => t.id === type) ?? TYPES[0]!;

  const visible = state.config.flow === 'annotate' && panelVisible(state);
  const sending = state.mode === 'sending';
  const showBack = state.mode === 'review' || state.mode === 'error';
  const invalid = !titleValid(state.draft.title);
  const reporter = reporterView(user);

  useLayoutEffect(() => {
    if (ref.current) adoptInto(ref.current);
  }, []);

  // Progress bar width through the CSSOM (strict CSP).
  useLayoutEffect(() => {
    if (barRef.current) barRef.current.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }, [progress, sending]);

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

  const pickType = (t: ReportType) => {
    if (sending) return;
    setOwnType({ session: state.session, type: t });
    props.onType?.(t);
  };

  return (
    <div
      ref={ref}
      class={`fw-panel${mini ? ' fw-panel--mini' : ''}${visible ? '' : ' fw-panel--hidden'}`}
      role="region"
      aria-label="Describe your feedback"
      aria-hidden={visible ? undefined : 'true'}
      aria-busy={sending ? 'true' : undefined}
    >
      {sending && <div ref={barRef} class="fw-pn-progress" data-part="progress" />}

      <div class="fw-pn-head">
        <div class="fw-pn-headrow">
          <div class="fw-pn-eyebrow">{EYEBROW}</div>
          {showBack && (
            <button type="button" class="fw-pn-back" data-part="back" onClick={() => dispatch({ type: 'backToMarks' })}>
              {BACK_LABEL}
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
        <h2 class="fw-pn-headline">{HEADLINE}</h2>
      </div>

      <div class="fw-pn-body">
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
            rows={DETAILS_ROWS}
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
    </div>
  );
}
