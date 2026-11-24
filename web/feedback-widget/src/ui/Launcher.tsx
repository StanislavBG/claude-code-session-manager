// Corner launcher — the bubble that sits on the host page all day. Handoff README §5.1
// "Corner (default)", ARIA from §4, visibility from §2 (machine.launcherVisible), icon from §8.
//
// Strict-CSP rule (tokens.ts): styles live in one constructed stylesheet adopted on the
// launcher's own root (the widget's shadow root) — never a `style` attribute or <style>.

import { useLayoutEffect, useRef } from 'preact/hooks';
import { launcherVisible, type State } from './machine';
import { colors, fonts, motion } from './tokens';

export const LAUNCHER_ARIA_LABEL = 'Send feedback (Shift+F)';

/** §8 "Launcher bubble" (24×24 viewBox, stroke currentColor 1.8, round caps/joins, no fill). */
export const BUBBLE_PATHS = [
  'M4.5 5.5h15a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1H10l-4.5 3.5V17H4.5a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z',
  'M8 10h8M8 13.2h5',
] as const;

/** §8 "Check" — shown (stroke 2.2) while the post-fold ping is up (§5.1 "Ping"). */
export const CHECK_PATH = 'M5 12.5l4.5 4.5L19 7.5';

const PAPER_12 = 'rgba(245,240,230,.12)';

/** Text of the launcher sheet (§5.1 corner + ping, §4 reduced motion). */
export function launcherCss(): string {
  const ease = motion.ease;
  return [
    `.fw-launcher{position:fixed;right:24px;bottom:24px;z-index:40;display:inline-flex;align-items:center;` +
      `height:52px;min-width:52px;padding:0 15px;border-radius:26px;background:${colors.ink};color:${colors.paper};` +
      `box-shadow:0 14px 34px -10px rgba(26,22,18,.65), inset 0 0 0 1px rgba(245,240,230,.08);` +
      `cursor:pointer;white-space:nowrap;transition:background-color 200ms ${ease}}`,
    `.fw-launcher:focus-visible{outline:2px solid ${colors.amber};outline-offset:3px}`,
    `.fw-launcher--ping{background:${colors.green}}`,
    `.fw-launcher-icon{flex:none;width:22px;height:22px}`,
    `.fw-launcher-slot{display:inline-flex;align-items:center;overflow:hidden;max-width:0;opacity:0;` +
      `transition:max-width 350ms ${ease}, opacity 200ms ${ease}}`,
    `.fw-launcher:hover .fw-launcher-slot,.fw-launcher:focus-visible .fw-launcher-slot{max-width:150px;opacity:1}`,
    `.fw-launcher-label{font-family:${fonts.sans};font-weight:600;font-size:14px;padding-left:10px;line-height:1}`,
    `.fw-launcher-key{font-family:${fonts.mono};font-weight:500;font-size:11px;padding:2px 6px;border-radius:5px;` +
      `background:${PAPER_12};color:${colors.amber};margin-left:8px;line-height:1.3}`,
    `@media (prefers-reduced-motion:reduce){.fw-launcher-slot{transition:max-width 0ms, opacity 150ms ${ease}}}`,
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

/** Adds the launcher sheet to the node's root (shadow root or document), once. */
function adoptOn(node: Node): void {
  const root = node.getRootNode() as (ShadowRoot | Document) & { adoptedStyleSheets?: CSSStyleSheet[] };
  const sheet = launcherSheet();
  if (!sheet || !root || !('adoptedStyleSheets' in root) || !root.adoptedStyleSheets) return;
  if (root.adoptedStyleSheets.includes(sheet)) return;
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

export interface LauncherProps {
  state: State;
  /** True while captureViewport() runs — the launcher must not appear in the screenshot. */
  capturing?: boolean;
  /** Launcher click; the caller dispatches `{ type: 'open' }` after capture. */
  onOpen: () => void;
}

export function Launcher({ state, capturing = false, onOpen }: LauncherProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const visible = launcherVisible(state) && !capturing;

  useLayoutEffect(() => {
    if (ref.current) adoptOn(ref.current);
  }, [visible]);

  if (!visible) return null;
  const ping = state.ping;
  return (
    <button
      ref={ref}
      type="button"
      class={ping ? 'fw-launcher fw-launcher--ping' : 'fw-launcher'}
      aria-label={LAUNCHER_ARIA_LABEL}
      onClick={() => onOpen()}
    >
      <svg
        class="fw-launcher-icon"
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width={ping ? '2.2' : '1.8'}
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        {ping ? <path d={CHECK_PATH} /> : BUBBLE_PATHS.map((d) => <path key={d} d={d} />)}
      </svg>
      <span class="fw-launcher-slot" aria-hidden="true">
        <span class="fw-launcher-label">Feedback</span>
        <span class="fw-launcher-key">⇧F</span>
      </span>
    </button>
  );
}
