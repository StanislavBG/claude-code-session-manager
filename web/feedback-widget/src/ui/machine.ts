// The widget's single source of truth for "what is shown when" — handoff §2 (State machine)
// plus the Esc priority of §3. Pure: no framework imports, no timers, no DOM access. Events are
// plain objects; components own every delay (420 ms Title focus, 480 ms fold, 6 s toast,
// 3.6 s ping) and dispatch the follow-up event (foldDone, toastExpired, pingDone) themselves.

export type Mode = 'idle' | 'annotate' | 'review' | 'sending' | 'sent' | 'error';
export type Flow = 'annotate' | 'docked' | 'note';
export type Success = 'receipt' | 'toast' | 'fold';
export type Tool = 'pin' | 'element' | 'box' | 'arrow' | 'draw' | 'text';

export interface MachineConfig {
  flow: Flow;
  success: Success;
}

/** The machine only tracks mark identity; geometry lives with the marks layer. */
export interface MarkRef {
  id: string;
}

export interface Draft {
  title: string;
  body: string;
}

export interface State {
  readonly config: MachineConfig;
  readonly mode: Mode;
  // Overlay flags (§2).
  readonly confirm: boolean;
  readonly folding: boolean;
  readonly toast: boolean;
  readonly ping: boolean;
  readonly popover: string | null;
  readonly textEdit: boolean;
  readonly drawing: boolean;
  readonly hover: object | null;
  // Session data.
  readonly tool: Tool;
  readonly marks: readonly MarkRef[];
  readonly draft: Draft;
  readonly toolbarPos: { x: number; y: number } | null;
  readonly titleError: boolean;
  readonly errorKind: 'retryable' | 'rejected' | null;
  readonly reportId: string | null;
  /** Increments on every open: components capture a new screenshot and flash when it changes. */
  readonly session: number;
  /** Increments whenever Title should take focus (Describe → after 420 ms; title error → now). */
  readonly focusTitleSeq: number;
}

export type Event =
  | { type: 'open' }
  | { type: 'describe' }
  | { type: 'backToMarks' }
  | { type: 'closeRequest' }
  | { type: 'keepEditing' }
  | { type: 'discard' }
  | { type: 'send' }
  | { type: 'sendOk'; id?: string | null }
  | { type: 'sendFail'; rejected?: boolean }
  | { type: 'foldDone' }
  | { type: 'pingDone' }
  | { type: 'toastExpired' }
  | { type: 'done' }
  | { type: 'sendAnother' }
  | { type: 'undoSend' }
  | { type: 'esc' }
  | { type: 'draft'; title?: string; body?: string }
  | { type: 'setTool'; tool: Tool }
  | { type: 'addMark'; id: string }
  | { type: 'removeMark'; id: string }
  | { type: 'undoMark' }
  | { type: 'popover'; id: string | null }
  | { type: 'textEdit'; on: boolean }
  | { type: 'drawing'; on: boolean }
  | { type: 'hover'; target: object | null }
  | { type: 'moveToolbar'; pos: { x: number; y: number } | null };

const EMPTY_DRAFT: Draft = { title: '', body: '' };
const MIN_TITLE = 3;

export function initialState(config: Partial<MachineConfig> = {}): State {
  return {
    config: { flow: config.flow ?? 'annotate', success: config.success ?? 'receipt' },
    mode: 'idle',
    confirm: false,
    folding: false,
    toast: false,
    ping: false,
    popover: null,
    textEdit: false,
    drawing: false,
    hover: null,
    tool: 'pin',
    marks: [],
    draft: EMPTY_DRAFT,
    toolbarPos: null,
    titleError: false,
    errorKind: null,
    reportId: null,
    session: 0,
    focusTitleSeq: 0,
  };
}

/** Back to idle with every session field reset; config and counters survive. */
function reset(s: State, extra: Partial<State> = {}): State {
  return {
    ...initialState(s.config),
    session: s.session,
    focusTitleSeq: s.focusTitleSeq,
    ping: s.ping,
    ...extra,
  };
}

function open(s: State): State {
  return {
    ...reset(s),
    mode: 'annotate',
    session: s.session + 1,
  };
}

function hasContent(s: State): boolean {
  return s.marks.length > 0 || s.draft.title.trim() !== '' || s.draft.body.trim() !== '';
}

function closeRequest(s: State): State {
  if (s.mode !== 'annotate' && s.mode !== 'review' && s.mode !== 'error') return s;
  return hasContent(s) ? { ...s, confirm: true } : reset(s);
}

function dropMark(s: State, id: string): State {
  const marks = s.marks.filter((m) => m.id !== id);
  return { ...s, marks, popover: s.popover === id ? null : s.popover };
}

export function reduce(s: State, e: Event): State {
  switch (e.type) {
    case 'open':
      return s.mode === 'idle' && !s.folding ? open(s) : s;

    case 'describe':
      if (s.mode !== 'annotate' || s.config.flow !== 'annotate' || s.confirm) return s;
      return { ...s, mode: 'review', popover: null, textEdit: false, focusTitleSeq: s.focusTitleSeq + 1 };

    case 'backToMarks':
      return s.mode === 'review' ? { ...s, mode: 'annotate', titleError: false } : s;

    case 'closeRequest':
      return closeRequest(s);

    case 'keepEditing':
      return s.confirm ? { ...s, confirm: false } : s;

    case 'discard':
      return s.confirm ? reset(s) : s;

    case 'send': {
      const canSend = s.mode === 'annotate' || s.mode === 'review' || s.mode === 'error';
      if (!canSend || s.confirm || !panelVisible(s)) return s;
      if (s.draft.title.trim().length < MIN_TITLE) {
        return { ...s, titleError: true, focusTitleSeq: s.focusTitleSeq + 1 };
      }
      return { ...s, mode: 'sending', titleError: false, errorKind: null, popover: null, textEdit: false, drawing: false, hover: null };
    }

    case 'sendOk': {
      if (s.mode !== 'sending' || s.folding) return s;
      const reportId = e.id ?? null;
      switch (s.config.success) {
        case 'receipt':
          return { ...s, mode: 'sent', reportId };
        case 'toast':
          // Draft and marks are kept so Undo can restore them until the toast expires.
          return { ...s, mode: 'idle', toast: true, reportId };
        case 'fold':
          return { ...s, folding: true, reportId };
      }
      return s;
    }

    case 'sendFail':
      return s.mode === 'sending' && !s.folding
        ? { ...s, mode: 'error', errorKind: e.rejected ? 'rejected' : 'retryable' }
        : s;

    case 'foldDone':
      return s.folding ? reset(s, { ping: true, reportId: s.reportId }) : s;

    case 'pingDone':
      return s.ping ? { ...s, ping: false } : s;

    case 'toastExpired':
      return s.toast && s.mode === 'idle' ? reset(s) : s.toast ? { ...s, toast: false } : s;

    case 'done':
      return s.mode === 'sent' ? reset(s) : s;

    case 'sendAnother':
      return s.mode === 'sent' ? open(reset(s)) : s;

    case 'undoSend':
      if (!s.toast || s.mode !== 'idle') return s;
      return { ...s, toast: false, reportId: null, mode: s.config.flow === 'annotate' ? 'review' : 'annotate' };

    case 'esc':
      if (s.confirm) return { ...s, confirm: false };
      if (s.textEdit) return { ...s, textEdit: false };
      if (s.popover !== null) return { ...s, popover: null };
      if (s.mode === 'sent') return reset(s);
      if (s.mode === 'review' && s.config.flow === 'annotate') return { ...s, mode: 'annotate', titleError: false };
      return closeRequest(s);

    case 'draft': {
      if (!isOpen(s)) return s;
      const draft = { title: e.title ?? s.draft.title, body: e.body ?? s.draft.body };
      const titleError = s.titleError && draft.title.trim().length < MIN_TITLE;
      return { ...s, draft, titleError };
    }

    case 'setTool':
      return isOpen(s) ? { ...s, tool: e.tool } : s;

    case 'addMark':
      return isOpen(s) ? { ...s, marks: [...s.marks, { id: e.id }] } : s;

    case 'removeMark':
      return dropMark(s, e.id);

    case 'undoMark': {
      const last = s.marks[s.marks.length - 1];
      return last ? dropMark(s, last.id) : s;
    }

    case 'popover':
      return { ...s, popover: e.id };

    case 'textEdit':
      return { ...s, textEdit: e.on };

    case 'drawing':
      return { ...s, drawing: e.on };

    case 'hover':
      return { ...s, hover: e.target };

    case 'moveToolbar':
      return { ...s, toolbarPos: e.pos };
  }
  return s;
}

// ── Selectors (§2 visibility rules) ──────────────────────────────────────────

/** The widget is open (capture backdrop up) in every mode but idle. */
export function isOpen(s: State): boolean {
  return s.mode !== 'idle';
}

const PANEL_AFTER_SEND: readonly Mode[] = ['sending', 'error', 'sent'];

export function panelVisible(s: State): boolean {
  switch (s.config.flow) {
    case 'annotate':
      return s.mode === 'review' || PANEL_AFTER_SEND.includes(s.mode);
    case 'docked':
      return isOpen(s);
    case 'note':
      return (isOpen(s) && s.marks.length > 0) || PANEL_AFTER_SEND.includes(s.mode);
  }
  return false;
}

export function toolbarVisible(s: State): boolean {
  return s.mode === 'annotate';
}

export function hintVisible(s: State): boolean {
  return s.mode === 'annotate' && !s.confirm;
}

export function frameVisible(s: State): boolean {
  return isOpen(s) && s.mode !== 'sent' && !s.folding;
}

export function launcherVisible(s: State): boolean {
  return s.mode === 'idle' || s.folding;
}

export function marksVisible(s: State): boolean {
  return isOpen(s);
}

/** Send button label: "Retry now" after a failure (§2). */
export function sendLabel(s: State): 'Send' | 'Retry now' {
  return s.mode === 'error' ? 'Retry now' : 'Send';
}
