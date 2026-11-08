/**
 * Which UI the Cockpit's main area shows.
 * - 'phone': the Projects → Sessions → Session drill-down is the primary UI; the desktop
 *   renderer (RemoteRenderer) is never mounted, so no desktop asset is fetched.
 * - 'full': the desktop's own renderer in a sandboxed iframe, drill-down as its fallback.
 * The default comes from the viewport class once per Cockpit mount (never on resize or
 * rotation); the header toggle stores an explicit choice that wins from then on.
 */
export type ViewMode = 'phone' | 'full';

export const VIEW_MODE_KEY = 'sm-remote-view-mode';

/** Phone-class browsers: narrow viewports, or touch-first screens up to tablet width. */
export const PHONE_QUERY = '(max-width: 767px), (pointer: coarse) and (max-width: 1024px)';

function isViewMode(v: unknown): v is ViewMode {
  return v === 'phone' || v === 'full';
}

export function defaultViewMode(): ViewMode {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'full';
    return window.matchMedia(PHONE_QUERY).matches ? 'phone' : 'full';
  } catch {
    return 'full';
  }
}

export function loadViewMode(): ViewMode {
  let stored: string | null;
  try {
    stored = localStorage.getItem(VIEW_MODE_KEY);
  } catch {
    return defaultViewMode();
  }
  return isViewMode(stored) ? stored : defaultViewMode();
}

export function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    /* private mode / quota — the choice just won't persist */
  }
}
