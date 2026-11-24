// Host mount for the embeddable feedback widget: resolves config, mounts one isolated
// host element (open shadow root) and exposes window.Feedback. Framework-free on purpose —
// the Preact UI mounts into `shadowRoot` in later modules.
//
// Strict-CSP rule (DESIGN_SPEC.md §"Decided changes" 3): styles go through CSSOM property
// writes and constructed stylesheets (adoptedStyleSheets) only — never a `style` attribute
// or a <style> element, so host pages without 'unsafe-inline' work.

declare const __WIDGET_VERSION__: string;

export const WIDGET_VERSION: string =
  typeof __WIDGET_VERSION__ === 'string' ? __WIDGET_VERSION__ : '0.0.0-dev';

export const HOST_ID = 'feedback-widget-host';
export const DEFAULT_MIN_VIEWPORT_WIDTH = 640;
const HOST_Z_INDEX = '2147483000';

export interface FeedbackUser {
  id?: string;
  name?: string;
  email?: string;
  /** Signature expiry from the site's backend; passed through unchanged for the desktop to verify. */
  exp?: number;
  /** Signature from the site's backend (the widget never holds the secret). */
  sig?: string;
}

export const SIG_MAX = 100;

/** Copies exp/sig onto `out` only when well-formed; malformed values are dropped. */
export function copySigned(from: { exp?: unknown; sig?: unknown }, out: { exp?: number; sig?: string }): void {
  if (typeof from.exp === 'number' && Number.isFinite(from.exp)) out.exp = from.exp;
  if (typeof from.sig === 'string' && from.sig.length > 0 && from.sig.length <= SIG_MAX) out.sig = from.sig;
}

/** window.FeedbackConfig as the embedding site writes it (README §1). */
export interface FeedbackConfigInput {
  key?: string;
  project?: string;
  endpoint?: string;
  user?: FeedbackUser | null;
  hotkey?: string;
  launcher?: 'corner' | 'edge' | 'mini' | 'hidden';
  flow?: 'annotate' | 'docked' | 'note';
  toolbar?: 'dock' | 'rail' | 'corner';
  success?: 'receipt' | 'toast' | 'fold';
  minViewportWidth?: number;
}

export interface BoxKey {
  boxId: string;
  fingerprint: string;
}

export interface ResolvedConfig {
  key: string | undefined;
  box: BoxKey | null;
  project: string | undefined;
  endpoint: string | undefined;
  user: FeedbackUser | null;
  hotkey: string;
  launcher: NonNullable<FeedbackConfigInput['launcher']>;
  flow: NonNullable<FeedbackConfigInput['flow']>;
  toolbar: NonNullable<FeedbackConfigInput['toolbar']>;
  success: NonNullable<FeedbackConfigInput['success']>;
  minViewportWidth: number;
}

export interface FeedbackApi {
  open(): void;
  close(): void;
  identify(user: FeedbackUser | null): void;
  readonly version: string;
}

declare global {
  interface Window {
    FeedbackConfig?: FeedbackConfigInput;
    Feedback?: FeedbackApi;
  }
}

// boxId = 8 Crockford base32 chars; fingerprint = first 22 chars of base64url(sha256(point))
// (architecture/site-feedback.md, Actors + Envelope v1).
const KEY_RE = /^fbk1_([0-9A-HJKMNP-TV-Z]{8})\.([A-Za-z0-9_-]{22})$/;

export function parseKey(key: string | null | undefined): BoxKey | null {
  if (typeof key !== 'string') return null;
  const m = KEY_RE.exec(key);
  return m ? { boxId: m[1], fingerprint: m[2] } : null;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function normalizeUser(user: unknown): FeedbackUser | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as Record<string, unknown>;
  const out: FeedbackUser = {};
  if (typeof u.id === 'string') out.id = u.id;
  if (typeof u.name === 'string') out.name = u.name;
  if (typeof u.email === 'string') out.email = u.email;
  if (!(out.id || out.name || out.email)) return null;
  copySigned(u, out);
  return out;
}

/** The <script> tag that loaded the widget (document.currentScript while it executes). */
function findOwnScript(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement) return current;
  return document.querySelector<HTMLScriptElement>('script[data-key], script[data-project]');
}

/** data-key / data-project on the script tag win over window.FeedbackConfig. */
export function resolveConfig(script: HTMLScriptElement | null = findOwnScript()): ResolvedConfig {
  const raw: FeedbackConfigInput =
    typeof window.FeedbackConfig === 'object' && window.FeedbackConfig ? window.FeedbackConfig : {};
  const key = script?.dataset.key || (typeof raw.key === 'string' ? raw.key : undefined);
  const project =
    script?.dataset.project || (typeof raw.project === 'string' ? raw.project : undefined);
  const minW = raw.minViewportWidth;
  return {
    key,
    box: parseKey(key),
    project,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : undefined,
    user: normalizeUser(raw.user),
    hotkey: typeof raw.hotkey === 'string' && raw.hotkey ? raw.hotkey : 'shift+f',
    launcher: pick(raw.launcher, ['corner', 'edge', 'mini', 'hidden'], 'corner'),
    flow: pick(raw.flow, ['annotate', 'docked', 'note'], 'annotate'),
    toolbar: pick(raw.toolbar, ['dock', 'rail', 'corner'], 'dock'),
    success: pick(raw.success, ['receipt', 'toast', 'fold'], 'receipt'),
    minViewportWidth:
      typeof minW === 'number' && Number.isFinite(minW) && minW >= 0
        ? minW
        : DEFAULT_MIN_VIEWPORT_WIDTH,
  };
}

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

function isTouchOnly(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  const coarse = window.matchMedia('(any-pointer: coarse)').matches ||
    window.matchMedia('(pointer: coarse)').matches;
  const fine = window.matchMedia('(any-pointer: fine)').matches ||
    window.matchMedia('(pointer: fine)').matches;
  return coarse && !fine;
}

// Page-wide guard so a second <script> tag (its own bundle copy) is a no-op too.
const MOUNT_FLAG = '__smFeedbackWidget__';
type FlagWindow = Window & { [MOUNT_FLAG]?: true };

interface HostState {
  host: HTMLElement;
  shadow: ShadowRoot;
  observer: MutationObserver;
  config: ResolvedConfig;
}

let state: HostState | null = null;
let reporter: FeedbackUser | null = null;

export function getReporter(): FeedbackUser | null {
  return reporter;
}

export function getHost(): HostState | null {
  return state;
}

const SHADOW_CSS = `:host{all:initial}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}`;

function applyShadowStyles(shadow: ShadowRoot): void {
  if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in shadow)) return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHADOW_CSS);
    shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
  } catch {
    // Constructable stylesheets unavailable — never fall back to <style> (strict CSP).
  }
}

function createHost(): HTMLElement {
  const host = document.createElement('div');
  host.id = HOST_ID;
  const s = host.style;
  s.position = 'fixed';
  s.inset = '0';
  // Longhands too, for engines whose CSSOM lacks the `inset` shorthand.
  s.top = '0';
  s.right = '0';
  s.bottom = '0';
  s.left = '0';
  s.zIndex = HOST_Z_INDEX;
  s.pointerEvents = 'none';
  return host;
}

function keepLast(host: HTMLElement): MutationObserver {
  const observer = new MutationObserver(() => {
    const body = document.body;
    if (!body) return;
    if (host.parentNode !== body || body.lastElementChild !== host) body.appendChild(host);
  });
  observer.observe(document.body, { childList: true });
  return observer;
}

function installApi(): void {
  const api: FeedbackApi = {
    // No-ops until index.ts wires them to the UI (or forever, when the widget did not render).
    open() {},
    close() {},
    identify(user) {
      reporter = user === null ? null : normalizeUser(user);
    },
    version: WIDGET_VERSION,
  };
  window.Feedback = api;
}

/**
 * Mounts the widget host. Returns true when it mounted, false when it declined
 * (not the top frame, already mounted, viewport too narrow, touch-only, no body).
 */
export function init(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  // window.Feedback always exists, so a host page calling Feedback.identify never throws —
  // even when the widget declines to render. An existing API (another bundle copy, or the
  // one index.ts wired) is left alone.
  const stubbed = !window.Feedback;
  if (stubbed) installApi();
  if (!isTopFrame()) return false;
  const w = window as FlagWindow;
  if (w[MOUNT_FLAG] || state || document.getElementById(HOST_ID)) return false;

  const config = resolveConfig();
  if (stubbed) reporter = config.user;
  if (window.innerWidth < config.minViewportWidth || isTouchOnly()) return false;
  if (!document.body) return false;

  w[MOUNT_FLAG] = true;
  reporter = config.user;
  const host = createHost();
  const shadow = host.attachShadow({ mode: 'open' });
  applyShadowStyles(shadow);
  document.body.appendChild(host);
  const observer = keepLast(host);
  state = { host, shadow, observer, config };
  installApi();
  return true;
}

/** Test-only: undo init() so each spec starts from a clean page. */
export function resetForTests(): void {
  if (state) {
    state.observer.disconnect();
    state.host.remove();
  }
  state = null;
  reporter = null;
  delete (window as FlagWindow)[MOUNT_FLAG];
}
