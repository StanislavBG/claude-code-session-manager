// App — the widget's one owner: holds the §2 machine state, the mark geometry and the capture,
// mounts every landed component inside the shadow root, and runs the send pipeline
// (buildReport → flattenAnnotated → buildMultipart → sendReport, outbox on a retryable failure).
//
// Open order (README "Screenshot capture"): the screenshot is taken FIRST, with the launcher
// unmounted and the host hidden, and only then does the machine enter `annotate` — so no
// widget pixel is ever in the capture. Launcher click, Shift+F and Feedback.open() all go
// through requestOpen(); "Send another" captures again the same way.
//
// Strict-CSP rule (tokens.ts): every style goes through constructed stylesheets.

import { render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Buffers, ConsoleEntry, NetworkEntry } from '../buffers';
import { captureViewport, type CaptureResult } from '../capture';
import { WIDGET_VERSION, type FeedbackUser, type ResolvedConfig } from '../host';
import { enqueue, type EnqueueInput } from '../outbox';
import {
  buildMultipart,
  buildReport,
  newClientReportId,
  type DraftMark,
  type MarkColor as ReportMarkColor,
  type ReportPage,
  type ReportType,
} from '../report';
import { sendReport, type SendOptions, type SendResult } from '../transport';
import { CaptureChrome } from './CaptureChrome';
import { DiscardDialog } from './DiscardDialog';
import { ElementPicker, type PickedElementMark } from './ElementPicker';
import { flattenAnnotated } from './flatten';
import { createFocusController, installKeys, reducedMotionCss } from './keys';
import { Launcher } from './Launcher';
import { initialState, isOpen, reduce, toolbarVisible, type Event, type State } from './machine';
import { MarksLayer, useMarks } from './MarksLayer';
import { DEFAULT_MARK_COLOR, type Mark, type MarkColor } from './marks';
import { DEFAULT_TYPE, Panel } from './Panel';
import { PanelContext } from './PanelContext';
import { type PanelSide } from './shared';
import { Toolbar } from './Toolbar';
import { baseSheet, loadFonts } from './tokens';

// ── Timings owned by the app (machine.ts: components own every delay) ─────────

export const FOLD_MS = 480;
export const TOAST_MS = 6000;
export const PING_MS = 3600;

// ── Services (injectable for tests) ─────────────────────────────────────────

export interface AppServices {
  capture(hostEl: HTMLElement | null): Promise<CaptureResult>;
  flatten(png: Blob, marks: readonly Mark[], scale: number): Promise<Blob>;
  multipart: typeof buildMultipart;
  send(o: SendOptions): Promise<SendResult>;
  enqueue(i: EnqueueInput): Promise<boolean>;
  newId(): string;
  now(): Date;
}

export const defaultServices: AppServices = {
  capture: (hostEl) => captureViewport({ hostEl }),
  flatten: (png, marks, scale) => flattenAnnotated(png, marks, { scale }),
  multipart: buildMultipart,
  send: sendReport,
  enqueue,
  newId: newClientReportId,
  now: () => new Date(),
};

/** The imperative face behind window.Feedback.open/close/identify. */
export interface AppController {
  open(): void;
  close(): void;
  identify(user: FeedbackUser | null): void;
}

export interface AppProps {
  config: ResolvedConfig;
  hostEl: HTMLElement | null;
  shadow: ShadowRoot | null;
  buffers?: Pick<Buffers, 'consoleEntries' | 'networkEntries'> | null;
  user?: FeedbackUser | null;
  services?: Partial<AppServices>;
  /** Receives the controller once mounted (and null on unmount). */
  onController?(c: AppController | null): void;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Page snapshot taken at open (report.page). */
export function snapshotPage(): ReportPage {
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
  };
}

/** Hostname of the page the report is about (the docked eyebrow), falling back to the live one. */
export function hostnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? location.href).hostname;
  } catch {
    return location.hostname;
  }
}

function tagFromSelector(selector: string): string {
  const m = /^[a-z][a-z0-9-]*/i.exec(selector.trim());
  return m ? m[0].toLowerCase() : 'element';
}

/** UI marks (marks.ts) → report builder marks, in creation order. */
export function toDraftMarks(marks: readonly Mark[]): DraftMark[] {
  return marks.map((m): DraftMark => {
    const color = m.color as ReportMarkColor;
    const note = (m as { comment?: string }).comment ?? '';
    switch (m.kind) {
      case 'pin':
        return { kind: 'pin', x: m.x, y: m.y, color, note };
      case 'box':
        return { kind: 'box', x: m.x, y: m.y, w: m.w, h: m.h, color, note };
      case 'element': {
        const el = (m as Partial<PickedElementMark>).element ?? { selector: m.selector, tag: tagFromSelector(m.selector) };
        return { kind: 'element', x: m.x, y: m.y, w: m.w, h: m.h, color, note, element: el };
      }
      case 'arrow':
        return { kind: 'arrow', x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, color };
      case 'draw':
        return { kind: 'draw', points: m.points.map((p) => [p.x, p.y] as [number, number]), color };
      case 'text':
        return { kind: 'text', x: m.x, y: m.y, text: m.text, color };
    }
  });
}

// ── Styles ──────────────────────────────────────────────────────────────────

/** The host is pointer-events:none; the widget's own interactive surfaces opt back in. */
export function appCss(): string {
  return [
    `.fw-launcher,.fw-tb,.fw-pop,.fw-panel:not(.fw-panel--hidden){pointer-events:auto}`,
    // The open-state landmark (role=dialog) is a semantic wrapper only: no box, no layout.
    `.fw-app{display:contents}`,
    reducedMotionCss(),
  ].join('\n');
}

let appSheetCache: CSSStyleSheet | null = null;

function adoptAppSheets(root: ShadowRoot | null): void {
  if (!root || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in root)) return;
  try {
    if (!appSheetCache) {
      appSheetCache = new CSSStyleSheet();
      appSheetCache.replaceSync(appCss());
    }
    const want = [baseSheet(), appSheetCache].filter((s) => !root.adoptedStyleSheets.includes(s));
    if (want.length) root.adoptedStyleSheets = [...root.adoptedStyleSheets, ...want];
  } catch {
    // Constructable stylesheets unusable — never fall back to <style> (strict CSP).
  }
}

// ── Component ───────────────────────────────────────────────────────────────

interface Session {
  capture: CaptureResult;
  capturedAt: Date;
  page: ReportPage;
  console: ConsoleEntry[];
  network: NetworkEntry[];
}

export function App(props: AppProps) {
  const { config, shadow } = props;
  const services: AppServices = { ...defaultServices, ...props.services };
  const live = useRef({ props, services });
  live.current = { props, services };

  const [state, setState] = useState<State>(() => initialState({ flow: config.flow, success: config.success }));
  const stateRef = useRef(state);
  const [capturing, setCapturing] = useState(false);
  const capturingRef = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [user, setUser] = useState<FeedbackUser | null>(props.user ?? config.user ?? null);
  const userRef = useRef(user);
  userRef.current = user;
  const [color, setColor] = useState<MarkColor>(DEFAULT_MARK_COLOR);
  const [reportType, setReportType] = useState<ReportType>(DEFAULT_TYPE);
  const reportTypeRef = useRef(reportType);
  reportTypeRef.current = reportType;
  const [switches, setSwitches] = useState({ console: true, network: true });
  const switchesRef = useRef(switches);
  switchesRef.current = switches;
  const [progress, setProgress] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  /** Flow `docked`: side of the panel column (§5.6 Swap side); kept across opens. */
  const [panelSide, setPanelSide] = useState<PanelSide>('right');
  /** One clientReportId per report: kept across Retry now, dropped on a new session. */
  const reportIdRef = useRef<string | null>(null);

  // Raw machine dispatch: reduce, store, and clear the marks when a session ends or restarts.
  const marksRef = useRef<ReturnType<typeof useMarks> | null>(null);
  const apply = useCallback((e: Event) => {
    const prev = stateRef.current;
    const next = reduce(prev, e);
    if (next === prev) return;
    stateRef.current = next;
    setState(next);
    const ended = !isOpen(next) && !next.toast && (isOpen(prev) || prev.toast);
    if (ended || next.session !== prev.session) {
      marksRef.current?.clear();
      reportIdRef.current = null;
      setHoveredId(null);
      if (ended && !next.folding) setProgress(0);
    }
    if (next.session !== prev.session) {
      setReportType(DEFAULT_TYPE);
      setSwitches({ console: true, network: true });
      setColor(DEFAULT_MARK_COLOR);
      setProgress(0);
    }
    if (next.mode === 'sending' && prev.mode !== 'sending') void runSend();
  }, []);

  const marks = useMarks(apply);
  marksRef.current = marks;

  /** Capture first (launcher hidden, host hidden by captureViewport), then reveal the UI. */
  const captureThen = useCallback(async (event: Event) => {
    if (capturingRef.current) return;
    capturingRef.current = true;
    setCapturing(true);
    try {
      const { props: p, services: s } = live.current;
      const capturedAt = s.now();
      const page = snapshotPage();
      const consoleEntries = p.buffers?.consoleEntries() ?? [];
      const networkEntries = p.buffers?.networkEntries() ?? [];
      // Let the launcher unmount before the rasteriser clones the DOM (captureViewport also
      // hides the whole host while it runs).
      await new Promise<void>((r) => setTimeout(r, 0));
      const capture = await s.capture(p.hostEl);
      const next: Session = { capture, capturedAt, page, console: consoleEntries, network: networkEntries };
      sessionRef.current = next;
      setSession(next);
      apply(event);
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  }, []);

  const requestOpen = useCallback(() => {
    const s = stateRef.current;
    if (s.mode !== 'idle' || s.folding) return;
    void captureThen({ type: 'open' });
  }, []);

  /** Public dispatch: open / sendAnother capture first; Ctrl+Z goes through the marks owner. */
  const dispatch = useCallback((e: Event) => {
    switch (e.type) {
      case 'open':
        requestOpen();
        return;
      case 'sendAnother':
        if (stateRef.current.mode === 'sent') void captureThen(e);
        return;
      case 'undoMark':
        marksRef.current?.undo();
        return;
      default:
        apply(e);
    }
  }, []);

  async function runSend(): Promise<void> {
    const { props: p, services: s } = live.current;
    const sess = sessionRef.current;
    const st = stateRef.current;
    const cfg = p.config;
    setProgress(0);
    if (!sess) {
      apply({ type: 'sendFail', rejected: true });
      return;
    }
    const clientReportId = (reportIdRef.current ??= s.newId());
    const uiMarks = marksRef.current?.marks ?? [];
    let result: SendResult;
    let multipart: Awaited<ReturnType<typeof buildMultipart>> | null = null;
    try {
      const report = buildReport({
        clientReportId,
        config: { project: cfg.project, boxId: cfg.box?.boxId ?? '' },
        draft: { type: reportTypeRef.current, title: st.draft.title, details: st.draft.body },
        marks: toDraftMarks(uiMarks),
        page: sess.page,
        capture: {
          capturedAt: sess.capturedAt,
          width: sess.capture.width,
          height: sess.capture.height,
          scale: sess.capture.scale,
          error: sess.capture.error,
        },
        buffers: { console: sess.console, network: sess.network },
        switches: switchesRef.current,
        reporter: userRef.current,
        widgetVersion: WIDGET_VERSION,
      });
      let annotated: Blob;
      try {
        annotated = await s.flatten(sess.capture.png, uiMarks, sess.capture.scale);
      } catch {
        annotated = sess.capture.png; // marks are still in report.json
      }
      multipart = await s.multipart(report, sess.capture.png, annotated);
      result = await s.send({
        key: cfg.box,
        endpoint: cfg.endpoint,
        project: cfg.project,
        multipart,
        clientReportId,
        onProgress: ({ loaded, total }) => {
          if (total > 0) setProgress(Math.round((loaded / total) * 100));
        },
      });
    } catch {
      result = { ok: false, kind: 'retryable' };
    }
    if (result.ok) {
      setProgress(100);
      apply({ type: 'sendOk', id: result.id ?? null });
      return;
    }
    if (result.kind === 'retryable' && multipart) {
      // The outbox keeps retrying with the SAME clientReportId; the relay de-duplicates.
      await s.enqueue({
        clientReportId,
        key: cfg.key ?? cfg.box,
        endpoint: cfg.endpoint,
        project: cfg.project,
        contentType: multipart.contentType,
        body: multipart.body,
      });
    }
    apply({ type: 'sendFail', rejected: result.kind !== 'retryable' });
  }

  // Controller for window.Feedback.
  useEffect(() => {
    const c: AppController = {
      open: () => requestOpen(),
      close: () => apply({ type: 'closeRequest' }),
      identify: (u) => setUser(u),
    };
    live.current.props.onController?.(c);
    return () => live.current.props.onController?.(null);
  }, []);

  // Styles + fonts.
  useLayoutEffect(() => {
    adoptAppSheets(shadow);
    loadFonts();
  }, [shadow]);

  // Keyboard map + focus controller (§3, §4).
  const focusRef = useRef<ReturnType<typeof createFocusController> | null>(null);
  useEffect(() => {
    const off = installKeys({ root: shadow, getState: () => stateRef.current, dispatch });
    const focus = shadow ? createFocusController({ root: shadow, getState: () => stateRef.current }) : null;
    focusRef.current = focus;
    return () => {
      off();
      focus?.dispose();
      focusRef.current = null;
    };
  }, [shadow]);
  useEffect(() => {
    focusRef.current?.update(state);
  }, [state]);

  // Follow-up events the machine expects from its owner.
  useEffect(() => {
    if (!state.folding) return;
    const t = setTimeout(() => apply({ type: 'foldDone' }), FOLD_MS);
    return () => clearTimeout(t);
  }, [state.folding]);
  useEffect(() => {
    if (!state.toast) return;
    const t = setTimeout(() => apply({ type: 'toastExpired' }), TOAST_MS);
    return () => clearTimeout(t);
  }, [state.toast]);
  useEffect(() => {
    if (!state.ping) return;
    const t = setTimeout(() => apply({ type: 'pingDone' }), PING_MS);
    return () => clearTimeout(t);
  }, [state.ping]);

  const open = isOpen(state);
  const annotating = state.mode === 'annotate' && !state.confirm;
  const capture = session?.capture ?? null;
  const scale = capture?.scale || 1;
  const shot = capture
    ? { width: Math.round(capture.width / scale), height: Math.round(capture.height / scale) }
    : { width: window.innerWidth, height: window.innerHeight };
  const consoleEntries = session?.console ?? [];
  const networkEntries = session?.network ?? [];
  const sending = state.mode === 'sending';

  return (
    <>
      <Launcher state={state} variant={config.launcher} capturing={capturing} onOpen={requestOpen} />
      {/* While open, every open-state part sits in one labelled modal landmark (axe 'region'),
          matching the focus trap. display:contents keeps it out of layout; the :host>* text rule
          still reaches every child through inheritance. */}
      <div
        class="fw-app"
        role={open ? 'dialog' : undefined}
        aria-modal={open ? 'true' : undefined}
        aria-label={open ? 'Send feedback' : undefined}
      >
      <CaptureChrome state={state} dispatch={dispatch} capture={capture} toolbar={config.toolbar} panelSide={panelSide}>
        <MarksLayer
          marks={marks.marks}
          tool={state.tool}
          color={color}
          enabled={annotating}
          popoverId={state.popover}
          hoveredId={hoveredId}
          onCreate={marks.add}
          onOpen={(id) => apply({ type: 'popover', id })}
          popover={{
            onChange: (id) => apply({ type: 'popover', id }),
            onComment: (id, value) => marks.update(id, { comment: value } as Partial<Mark>),
            onDelete: (id) => {
              marks.remove(id);
              apply({ type: 'popover', id: null });
            },
            skipOpenOnCreate: state.config.flow === 'note' && marks.marks.length === 0,
            W: shot.width,
            H: shot.height,
          }}
          onTextEdit={(on) => apply({ type: 'textEdit', on })}
          onDrawing={(on) => apply({ type: 'drawing', on })}
        />
        <ElementPicker
          active={annotating && state.tool === 'element'}
          color={color}
          onCreate={(mark) => {
            marks.add(mark);
            // §5.5: a picked element opens its comment popover like a pin or box does.
            if (!(state.config.flow === 'note' && marks.marks.length === 0)) apply({ type: 'popover', id: mark.id });
          }}
          onHover={(el) => apply({ type: 'hover', target: el })}
        />
      </CaptureChrome>
      {open && (
        <Toolbar
          visible={toolbarVisible(state)}
          tool={state.tool}
          color={color}
          offset={state.toolbarPos}
          flow={state.config.flow}
          panelSide={panelSide}
          placement={config.toolbar}
          onTool={(tool) => apply({ type: 'setTool', tool })}
          onColor={setColor}
          onUndo={() => marks.undo()}
          onDescribe={() => apply({ type: 'describe' })}
          onClose={() => apply({ type: 'closeRequest' })}
          onMove={(pos) => apply({ type: 'moveToolbar', pos })}
        />
      )}
      {open && (
        <Panel
          state={state}
          dispatch={dispatch}
          progress={progress}
          user={user}
          reportType={reportType}
          onType={setReportType}
          mini={config.launcher === 'mini'}
          side={panelSide}
          onSwap={setPanelSide}
          hostname={hostnameOf(session?.page.url)}
          attached={{
            width: shot.width,
            height: shot.height,
            console: { count: consoleEntries.length, on: switches.console },
            network: { count: networkEntries.length, on: switches.network },
          }}
        >
          <PanelContext
            marks={marks.marks}
            onNote={(id, note) => marks.update(id, { comment: note } as Partial<Mark>)}
            onRemove={(id) => marks.remove(id)}
            onHover={setHoveredId}
            screenshot={shot}
            pageUrl={session?.page.url ?? location.href}
            console={consoleEntries}
            network={networkEntries}
            switches={switches}
            onSwitch={(name, on) => setSwitches((s) => ({ ...s, [name]: on }))}
            disabled={sending}
          />
        </Panel>
      )}
      <DiscardDialog state={state} dispatch={dispatch} />
      </div>
    </>
  );
}

// ── Mount ───────────────────────────────────────────────────────────────────

export interface MountOptions extends Omit<AppProps, 'onController'> {
  /** Defaults to `shadow`. */
  container?: ParentNode | null;
}

export interface MountedApp extends AppController {
  unmount(): void;
}

/**
 * Renders App into the shadow root and returns its controller. Calls made before the first
 * effect runs (synchronously after render) are queued and replayed.
 */
export function mountApp(opts: MountOptions): MountedApp {
  const target = (opts.container ?? opts.shadow) as unknown as Element | null;
  let ctrl: AppController | null = null;
  const queued: ((c: AppController) => void)[] = [];
  const call = (fn: (c: AppController) => void) => (ctrl ? fn(ctrl) : queued.push(fn));
  if (target) {
    render(
      <App
        {...opts}
        onController={(c) => {
          ctrl = c;
          if (c) for (const fn of queued.splice(0)) fn(c);
        }}
      />,
      target,
    );
  }
  return {
    open: () => call((c) => c.open()),
    close: () => call((c) => c.close()),
    identify: (u) => call((c) => c.identify(u)),
    unmount: () => {
      if (target) render(null, target);
      ctrl = null;
    },
  };
}
