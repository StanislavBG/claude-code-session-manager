// Launcher — the thing that sits on the host page all day. Handoff README §5.1 (corner default,
// edge, mini, hidden + one-time coach toast), §5.7 "Position" (toast / ping anchor per
// launcher), ARIA from §4, visibility from §2 (machine.launcherVisible), icons from §8.
//
// Strict-CSP rule (tokens.ts): styles live in one constructed stylesheet adopted on the
// launcher's own root (the widget's shadow root) — never a `style` attribute or <style>.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { launcherVisible, type State } from './machine';
import { adoptInto } from './shared';
import { colors, fonts, motion } from './tokens';

export type LauncherVariant = 'corner' | 'edge' | 'mini' | 'hidden';

export const LAUNCHER_ARIA_LABEL = 'Send feedback (Shift+F)';

/** §8 "Launcher bubble" (24×24 viewBox, stroke currentColor 1.8, round caps/joins, no fill). */
export const BUBBLE_PATHS = [
  'M4.5 5.5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H10l-4.5 3.5V17H4.5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z',
  'M8 10h8M8 13.2h5',
] as const;

/** §8 "Check" — shown (stroke 2.2) while the post-fold ping is up (§5.1 "Ping"). */
export const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5';

/** §5.1 Hidden: the coach toast shows once per browser. */
export const COACH_SEEN_KEY = 'fw:coachSeen';
/** §5.1 Hidden: the coach toast auto-hides after 9 s. */
export const COACH_MS = 9000;

const PAPER_12 = 'rgba(245,240,230,.12)';
const PAPER_20 = 'rgba(245,240,230,.2)';

/**
 * §5.7 "Position (also used for the ping bubble)": where a toast / ping bubble sits for each
 * launcher. Visible launcher boxes (design `lBox`): corner 52×52 at right/bottom 24; edge 40 px
 * of tab showing, vertically centred; mini 38×38 at left/bottom 20.
 */
export const ANCHOR_DECLS: Readonly<Record<LauncherVariant, string>> = {
  // right-aligned to the launcher, 14 px above it (24 + 52 + 14)
  corner: 'right:24px;bottom:90px',
  // 14 px left of the tab (40 visible + 14), vertically centred
  edge: 'right:54px;top:50%;transform:translateY(-50%)',
  // left 20, 12 px above the launcher (20 + 38 + 12)
  mini: 'left:20px;bottom:70px',
  // bottom-right, 20 px from both edges
  hidden: 'right:20px;bottom:20px',
};

/** Class a toast / ping bubble adds to sit at the §5.7 anchor of `variant` (rules in launcherCss). */
export function anchorClass(variant: LauncherVariant): string {
  return `fw-anchor fw-anchor--${variant}`;
}

/** Text of the launcher sheet (§5.1 all variants + ping + coach, §5.7 anchors, §4 reduced motion). */
export function launcherCss(): string {
  const ease = motion.ease;
  const c = colors;
  return [
    // Shared by every visible variant.
    `.fw-launcher{position:fixed;z-index:40;box-sizing:border-box;display:inline-flex;align-items:center;` +
      `justify-content:center;border:0;margin:0;cursor:pointer;white-space:nowrap;` +
      `transition:background-color 200ms ${ease}, color 200ms ${ease}}`,
    `.fw-launcher:focus-visible{outline:2px solid ${c.amber};outline-offset:3px}`,
    `.fw-launcher-icon{flex:none;display:block}`,
    `.fw-launcher-slot{display:inline-flex;align-items:center;overflow:hidden;max-width:0;opacity:0;` +
      `transition:max-width 350ms ${ease}, opacity 200ms ${ease}}`,
    `.fw-launcher:hover .fw-launcher-slot,.fw-launcher:focus-visible .fw-launcher-slot{max-width:150px;opacity:1}`,

    // Corner (default).
    `.fw-launcher--corner{right:24px;bottom:24px;height:52px;min-width:52px;padding:0 15px;border-radius:26px;` +
      `background:${c.ink};color:${c.paper};` +
      `box-shadow:0 14px 34px -10px rgba(26,22,18,.65), inset 0 0 0 1px rgba(245,240,230,.08)}`,
    `.fw-launcher--corner .fw-launcher-icon{width:22px;height:22px}`,
    `.fw-launcher--corner .fw-launcher-label{font-family:${fonts.sans};font-weight:600;font-size:14px;padding-left:10px;line-height:1}`,
    `.fw-launcher--corner .fw-launcher-key{font-family:${fonts.mono};font-weight:500;font-size:11px;padding:2px 6px;border-radius:5px;` +
      `background:${PAPER_12};color:${c.amber};margin-left:8px;line-height:1.3}`,

    // Edge.
    `.fw-launcher--edge{right:-6px;top:50%;transform:translateY(-50%);width:46px;flex-direction:column;gap:10px;` +
      `padding:14px 6px 14px 0;border-radius:10px 0 0 10px;background:${c.ink};color:${c.paper};` +
      `box-shadow:-10px 10px 30px -12px rgba(26,22,18,.6);` +
      `transition:transform 250ms ${ease}, background-color 200ms ${ease}}`,
    `.fw-launcher--edge:hover,.fw-launcher--edge:focus-visible{transform:translateY(-50%) translateX(-6px)}`,
    `.fw-launcher--edge .fw-launcher-icon{width:18px;height:18px}`,
    `.fw-launcher--edge .fw-launcher-label{writing-mode:vertical-rl;transform:rotate(180deg);` +
      `font-family:${fonts.sans};font-weight:600;font-size:13px;letter-spacing:.02em;line-height:1}`,
    `.fw-launcher--edge .fw-launcher-key{font-family:${fonts.mono};font-weight:500;font-size:10px;color:${c.amber};` +
      `line-height:1.3;opacity:0;transition:opacity 200ms ${ease}}`,
    `.fw-launcher--edge:hover .fw-launcher-key,.fw-launcher--edge:focus-visible .fw-launcher-key{opacity:1}`,

    // Mini.
    `.fw-launcher--mini{left:20px;bottom:20px;height:38px;min-width:38px;padding:0 9px;border-radius:19px;` +
      `border:1px solid ${c.rule};background:${c.paper};color:${c.ink};` +
      `box-shadow:0 8px 22px -10px rgba(26,22,18,.45)}`,
    `.fw-launcher--mini .fw-launcher-icon{width:18px;height:18px}`,
    `.fw-launcher--mini .fw-launcher-label{font-family:${fonts.sans};font-weight:600;font-size:13px;padding-left:8px;line-height:1}`,
    `.fw-launcher--mini .fw-launcher-key{font-family:${fonts.mono};font-weight:500;font-size:10.5px;padding:2px 5px;border-radius:4px;` +
      `background:${c['paper-3']};color:${c['ink-3']};margin-left:8px;line-height:1.3}`,

    // Ping (after fold success) — every variant goes green; mini also flips its text to paper.
    `.fw-launcher--ping{background:${c.green}}`,
    `.fw-launcher--mini.fw-launcher--ping{background:${c.green};color:${c.paper}}`,

    // Hidden: the one-time coach toast.
    `.fw-coach{position:fixed;z-index:40;right:20px;bottom:20px;display:flex;align-items:center;gap:14px;` +
      `padding:10px 10px 10px 16px;border-radius:12px;background:${c.ink};color:${c.paper};` +
      `box-shadow:0 14px 34px -12px rgba(26,22,18,.6);pointer-events:auto;` +
      `font-family:${fonts.sans};font-weight:500;font-size:13.5px;line-height:1.3}`,
    `.fw-coach-copy{display:flex;align-items:center;gap:6px;white-space:nowrap}`,
    `.fw-coach-cap{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;` +
      `min-width:22px;height:22px;padding:0 5px;border-radius:5px;background:${c.paper};color:${c.ink};` +
      `font-family:${fonts.mono};font-weight:600;font-size:11px;box-shadow:inset 0 -2px 0 ${c['rule-strong']}}`,
    `.fw-coach-ok{height:30px;padding:0 12px;border:0;margin:0;border-radius:8px;background:${PAPER_12};color:${c.paper};` +
      `font-family:${fonts.sans};font-weight:600;font-size:12.5px;cursor:pointer;white-space:nowrap;` +
      `transition:background-color 150ms ${ease}}`,
    `.fw-coach-ok:hover{background:${PAPER_20}}`,
    `.fw-coach-ok:focus-visible{outline:2px solid ${c.amber};outline-offset:2px}`,

    // §5.7 toast / ping anchors.
    `.fw-anchor{position:fixed}`,
    ...(Object.keys(ANCHOR_DECLS) as LauncherVariant[]).map((v) => `.fw-anchor--${v}{${ANCHOR_DECLS[v]}}`),

    `@media (prefers-reduced-motion:reduce){.fw-launcher-slot{transition:max-width 0ms, opacity 150ms ${ease}}` +
      `.fw-launcher--edge{transition:background-color 150ms ${ease}}}`,
  ].join('\n');
}

let sheetCache: CSSStyleSheet | null = null;

/** The one constructed launcher sheet (null where constructable sheets are unavailable). */
export function launcherSheet(): CSSStyleSheet | null {
  if (sheetCache) return sheetCache;
  if (typeof CSSStyleSheet !== 'function') return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(launcherCss());
    sheetCache = sheet;
  } catch {
    return null;
  }
  return sheetCache;
}

/** True once the coach toast has been shown in this browser (storage errors count as unseen). */
export function coachSeen(): boolean {
  try {
    return window.localStorage.getItem(COACH_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

function markCoachSeen(): void {
  try {
    window.localStorage.setItem(COACH_SEEN_KEY, '1');
  } catch {
    // Storage blocked (privacy mode / sandboxed iframe) — the hint may show again next load.
  }
}

export interface LauncherProps {
  state: State;
  /** FeedbackConfig.launcher; defaults to `corner` (§1, "Variants: build the defaults first"). */
  variant?: LauncherVariant;
  /** True while captureViewport() runs — the launcher must not appear in the screenshot. */
  capturing?: boolean;
  /** Launcher click; the caller dispatches `{ type: 'open' }` after capture. */
  onOpen: () => void;
}

function Icon({ size, ping, full }: { size: 18 | 22; ping: boolean; full: boolean }) {
  return (
    <svg
      class="fw-launcher-icon"
      width={String(size)}
      height={String(size)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={ping ? '2.2' : '1.8'}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {ping ? (
        <path d={CHECK_PATH} />
      ) : (
        (full ? BUBBLE_PATHS : BUBBLE_PATHS.slice(0, 1)).map((d) => <path key={d} d={d} />)
      )}
    </svg>
  );
}

/** §5.1 Hidden: "Spotted a problem? Press [⇧] [F] to send feedback" + Got it, once per browser. */
function Coach({ show }: { show: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Decided once per mount: unseen → eligible. It is recorded as seen only once it is actually
  // on screen (idle, not capturing), so a hidden mount never uses up the one-time hint.
  const [open, setOpen] = useState(() => !coachSeen());
  const visible = open && show;

  useEffect(() => {
    if (!visible) return undefined;
    markCoachSeen();
    const t = setTimeout(() => setOpen(false), COACH_MS);
    return () => clearTimeout(t);
  }, [visible]);

  useLayoutEffect(() => {
    if (visible) adoptInto(ref.current, launcherSheet());
  }, [visible]);

  if (!visible) return null;
  return (
    <div ref={ref} class="fw-coach" role="status">
      <span class="fw-coach-copy">
        Spotted a problem? Press
        <kbd class="fw-coach-cap">⇧</kbd>
        <kbd class="fw-coach-cap">F</kbd>
        to send feedback
      </span>
      <button type="button" class="fw-coach-ok" onClick={() => setOpen(false)}>
        Got it
      </button>
    </div>
  );
}

export function Launcher({ state, variant = 'corner', capturing = false, onOpen }: LauncherProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const visible = launcherVisible(state) && !capturing;

  useLayoutEffect(() => {
    if (ref.current) adoptInto(ref.current, launcherSheet());
  }, [visible, variant]);

  if (variant === 'hidden') {
    // No launcher; the coach shows only in plain idle (not over a toast, ping or capture).
    return <Coach show={visible && state.mode === 'idle' && !state.ping} />;
  }
  if (!visible) return null;
  const ping = state.ping;
  const cls = `fw-launcher fw-launcher--${variant}${ping ? ' fw-launcher--ping' : ''}`;

  if (variant === 'edge') {
    return (
      <button ref={ref} type="button" class={cls} aria-label={LAUNCHER_ARIA_LABEL} onClick={() => onOpen()}>
        <Icon size={18} ping={ping} full={false} />
        <span class="fw-launcher-label" aria-hidden="true">
          Feedback
        </span>
        <span class="fw-launcher-key" aria-hidden="true">
          ⇧F
        </span>
      </button>
    );
  }

  return (
    <button ref={ref} type="button" class={cls} aria-label={LAUNCHER_ARIA_LABEL} onClick={() => onOpen()}>
      <Icon size={variant === 'mini' ? 18 : 22} ping={ping} full={variant === 'corner'} />
      <span class="fw-launcher-slot" aria-hidden="true">
        <span class="fw-launcher-label">Feedback</span>
        <span class="fw-launcher-key">⇧F</span>
      </span>
    </button>
  );
}
