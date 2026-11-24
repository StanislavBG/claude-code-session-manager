// Report v1 builder (schema/report.v1.json). Pure: turns the widget's state at send time into
// the report.json object and the three-part multipart body the handoff seals and POSTs.
//
// Every value is normalised to the schema here (trims, clips, integer rounding, degenerate
// marks dropped) so the output always validates — the UI never has to know the schema.

import type { ConsoleEntry, NetworkEntry } from './buffers';
import type { ElementDescription } from './selector';
import type { FeedbackUser } from './host';

// ---------- Report v1 types ----------

export type MarkColor = '#a83818' | '#f4b942' | '#2e5a3e' | '#1a1612';
export type ReportType = 'bug' | 'feature' | 'other';

export interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

export interface ReportPage {
  url: string;
  title: string;
  viewport: Viewport;
}

export interface ReportScreenshot {
  part: 'screenshot';
  annotatedPart: 'annotated';
  width: number;
  height: number;
  scale: number;
}

export interface ReportElement {
  selector: string;
  label?: string;
  tag: string;
  id?: string;
  classes?: string[];
  text?: string;
  role?: string;
  ariaLabel?: string;
  xpath?: string;
}

export interface PinMark { kind: 'pin'; n: number; x: number; y: number; color: MarkColor; note: string }
export interface BoxMark { kind: 'box'; n: number; x: number; y: number; w: number; h: number; color: MarkColor; note: string }
export interface ElementMark {
  kind: 'element'; n: number; x: number; y: number; w: number; h: number; color: MarkColor; note: string;
  element: ReportElement;
}
export interface ArrowMark { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number; color: MarkColor }
export interface DrawMark { kind: 'draw'; points: [number, number][]; color: MarkColor }
export interface TextMark { kind: 'text'; x: number; y: number; text: string; color: MarkColor }
export type ReportMark = PinMark | BoxMark | ElementMark | ArrowMark | DrawMark | TextMark;

export interface ReportConsoleEntry {
  level: 'error';
  message: string;
  stack?: string;
  source?: string;
  timestamp: string;
  count: number;
}

export interface ReportNetworkEntry {
  method: string;
  url: string;
  status: number | 'network-error' | 'timeout';
  durationMs: number;
  timestamp: string;
}

export interface ReportUser {
  id: string;
  name?: string;
  email?: string;
}

export interface ReportV1 {
  schemaVersion: 1;
  clientReportId: string;
  project: string;
  type: ReportType;
  title: string;
  details: string;
  createdAt: string;
  page: ReportPage;
  screenshot: ReportScreenshot;
  marks: ReportMark[];
  console: ReportConsoleEntry[] | null;
  network: ReportNetworkEntry[] | null;
  user: ReportUser | null;
  client: { widgetVersion: string; captureError?: string };
}

// ---------- Builder input ----------

type Unnumbered<T> = T extends { n: number } ? Omit<T, 'n' | 'note'> & { note?: string } : T;

/** A mark as the canvas holds it: no `n` (assigned here, in creation order), note optional. */
export type DraftMark =
  | Unnumbered<PinMark>
  | Unnumbered<BoxMark>
  | (Omit<ElementMark, 'n' | 'note' | 'element'> & { note?: string; element: ElementDescription | ReportElement })
  | ArrowMark
  | DrawMark
  | TextMark;

export interface ReportState {
  /** Caller generates once per report (newClientReportId) and re-sends it on every retry. */
  clientReportId?: string;
  config: { project?: string; boxId: string };
  draft: { type: ReportType; title: string; details: string };
  /** In creation order. */
  marks: readonly DraftMark[];
  /** Snapshot taken when the widget opened. */
  page: ReportPage;
  capture: { capturedAt: string | Date; width: number; height: number; scale: number; error?: string };
  buffers: { console: readonly ConsoleEntry[]; network: readonly NetworkEntry[] };
  switches: { console: boolean; network: boolean };
  reporter: FeedbackUser | null;
  widgetVersion: string;
}

// ---------- Limits (mirrors schema/report.v1.json) ----------

export const TITLE_MAX = 120;
export const DETAILS_MAX = 5000;
export const NOTE_MAX = 1000;
export const TEXT_MARK_MAX = 140;
export const ELEMENT_TEXT_MAX = 80;
export const BOX_MIN = 8;
export const DRAW_MIN_POINTS = 3;
export const ENTRIES_MAX = 20;
export const MESSAGE_MAX = 500;
export const STACK_MAX = 2000;
export const CAPTURE_ERROR_MAX = 200;

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s);
const int = (v: number): number => (Number.isFinite(v) ? Math.round(v) : 0);
const num = (v: number): number => (Number.isFinite(v) ? v : 0);

export function newClientReportId(): string {
  return crypto.randomUUID();
}

function toIso(t: string | Date): string {
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function element(e: ElementDescription | ReportElement): ReportElement {
  const out: ReportElement = { selector: e.selector, tag: e.tag };
  if (e.label) out.label = e.label;
  if (e.id) out.id = e.id;
  if (e.classes && e.classes.length) out.classes = [...e.classes];
  if (e.text) out.text = clip(e.text, ELEMENT_TEXT_MAX);
  if (e.role) out.role = e.role;
  if (e.ariaLabel) out.ariaLabel = e.ariaLabel;
  if (e.xpath) out.xpath = e.xpath;
  return out;
}

const note = (s: string | undefined): string => clip((s ?? '').trim(), NOTE_MAX);

function marks(drafts: readonly DraftMark[]): ReportMark[] {
  const out: ReportMark[] = [];
  let n = 0;
  for (const m of drafts) {
    switch (m.kind) {
      case 'pin':
        out.push({ kind: 'pin', n: ++n, x: num(m.x), y: num(m.y), color: m.color, note: note(m.note) });
        break;
      case 'box':
        if (!(m.w >= BOX_MIN && m.h >= BOX_MIN)) break;
        out.push({ kind: 'box', n: ++n, x: num(m.x), y: num(m.y), w: m.w, h: m.h, color: m.color, note: note(m.note) });
        break;
      case 'element':
        out.push({
          kind: 'element', n: ++n, x: num(m.x), y: num(m.y), w: num(m.w), h: num(m.h),
          color: m.color, note: note(m.note), element: element(m.element),
        });
        break;
      case 'arrow':
        out.push({ kind: 'arrow', x1: num(m.x1), y1: num(m.y1), x2: num(m.x2), y2: num(m.y2), color: m.color });
        break;
      case 'draw':
        if (m.points.length < DRAW_MIN_POINTS) break;
        out.push({ kind: 'draw', points: m.points.map(([x, y]) => [num(x), num(y)] as [number, number]), color: m.color });
        break;
      case 'text': {
        const text = clip(m.text.trim(), TEXT_MARK_MAX);
        if (!text) break;
        out.push({ kind: 'text', x: num(m.x), y: num(m.y), text, color: m.color });
        break;
      }
    }
  }
  return out;
}

function consoleEntries(entries: readonly ConsoleEntry[]): ReportConsoleEntry[] {
  return entries.slice(-ENTRIES_MAX).map((e) => {
    const out: ReportConsoleEntry = {
      level: 'error',
      message: clip(e.message, MESSAGE_MAX),
      timestamp: toIso(e.timestamp),
      count: Math.max(1, int(e.count)),
    };
    if (e.stack) out.stack = clip(e.stack, STACK_MAX);
    if (e.source) out.source = e.source;
    return out;
  });
}

function networkEntries(entries: readonly NetworkEntry[]): ReportNetworkEntry[] {
  return entries.slice(-ENTRIES_MAX).map((e) => ({
    method: e.method,
    url: e.url,
    status: typeof e.status === 'number' ? Math.max(400, int(e.status)) : e.status,
    durationMs: Math.max(0, int(e.durationMs)),
    timestamp: toIso(e.timestamp),
  }));
}

/** null when no reporter; the schema requires `id`, so fall back to email, then name. */
function user(r: FeedbackUser | null): ReportUser | null {
  if (!r) return null;
  const id = r.id || r.email || r.name;
  if (!id) return null;
  const out: ReportUser = { id };
  if (r.name) out.name = r.name;
  if (r.email) out.email = r.email;
  return out;
}

export function buildReport(state: ReportState): ReportV1 {
  const { page, capture } = state;
  const client: ReportV1['client'] = { widgetVersion: state.widgetVersion };
  if (capture.error) client.captureError = clip(capture.error, CAPTURE_ERROR_MAX);
  return {
    schemaVersion: 1,
    clientReportId: state.clientReportId ?? newClientReportId(),
    project: state.config.project || state.config.boxId,
    type: state.draft.type,
    title: clip(state.draft.title.trim(), TITLE_MAX),
    details: clip(state.draft.details.trim(), DETAILS_MAX),
    createdAt: toIso(capture.capturedAt),
    page: {
      url: page.url,
      title: page.title,
      viewport: {
        width: int(page.viewport.width),
        height: int(page.viewport.height),
        devicePixelRatio: num(page.viewport.devicePixelRatio) || 1,
        scrollX: int(page.viewport.scrollX),
        scrollY: int(page.viewport.scrollY),
      },
    },
    screenshot: {
      part: 'screenshot',
      annotatedPart: 'annotated',
      width: int(capture.width),
      height: int(capture.height),
      scale: num(capture.scale) || 1,
    },
    marks: marks(state.marks),
    console: state.switches.console ? consoleEntries(state.buffers.console) : null,
    network: state.switches.network ? networkEntries(state.buffers.network) : null,
    user: user(state.reporter),
    client,
  };
}

// ---------- Multipart ----------

export interface MultipartBody {
  body: Uint8Array<ArrayBuffer>;
  /** `multipart/form-data; boundary=…` */
  contentType: string;
}

function pngBlob(png: Blob | Uint8Array): Blob {
  if (png instanceof Blob) return png.type === 'image/png' ? png : new Blob([png], { type: 'image/png' });
  return new Blob([png as BlobPart], { type: 'image/png' });
}

/** Three parts: report (application/json), screenshot + annotated (image/png). */
export async function buildMultipart(
  report: ReportV1,
  screenshotPng: Blob | Uint8Array,
  annotatedPng: Blob | Uint8Array,
): Promise<MultipartBody> {
  const fd = new FormData();
  fd.append('report', new Blob([JSON.stringify(report)], { type: 'application/json' }), 'report.json');
  fd.append(report.screenshot.part, pngBlob(screenshotPng), 'screenshot.png');
  fd.append(report.screenshot.annotatedPart, pngBlob(annotatedPng), 'annotated.png');
  const res = new Response(fd);
  const contentType = res.headers.get('content-type') ?? '';
  const body = new Uint8Array(await res.arrayBuffer());
  return { body, contentType };
}
