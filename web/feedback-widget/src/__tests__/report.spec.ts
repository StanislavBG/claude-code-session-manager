// @vitest-environment node
// Node env: FormData, Blob and Response must come from the same (undici) implementation.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { buildMultipart, buildReport, type DraftMark, type ReportState } from '../report';

const schema = JSON.parse(readFileSync(new URL('../../schema/report.v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function expectValid(report: unknown): void {
  const ok = validate(report);
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALL_MARKS: DraftMark[] = [
  {
    kind: 'element', x: 268, y: 735, w: 77, h: 34, color: '#a83818', note: '  Click does nothing  ',
    element: {
      selector: 'article.stay-card:nth-of-type(1) button.book', label: 'button.book', tag: 'button',
      classes: ['book'], text: 'Book', xpath: '/html/body/main/section[2]/div[2]/article[1]/div[3]/button',
    },
  },
  { kind: 'pin', x: 160, y: 756, color: '#a83818', note: 'Price flickers' },
  { kind: 'draw', points: [[121, 690], [150, 683], [190, 681], [230, 684]], color: '#f4b942' },
  { kind: 'text', x: 383, y: 564, text: 'This one works', color: '#2e5a3e' },
  { kind: 'arrow', x1: 455, y1: 586, x2: 589, y2: 729, color: '#2e5a3e' },
  { kind: 'box', x: 10, y: 20, w: 100, h: 50, color: '#1a1612' },
];

function state(over: Partial<ReportState> = {}): ReportState {
  return {
    config: { project: 'lumen', boxId: 'ABCDEFGH' },
    draft: { type: 'bug', title: '  Book does nothing  ', details: '\n Clicked twice. \n' },
    marks: ALL_MARKS,
    page: {
      url: 'https://lumenstays.com/stays/lisbon?in=03-14#x',
      title: 'Lisbon stays · Lumen',
      viewport: { width: 1280, height: 800, devicePixelRatio: 2, scrollX: 0, scrollY: 120 },
    },
    capture: { capturedAt: new Date('2026-11-23T10:42:17.204Z'), width: 2560, height: 1600, scale: 2 },
    buffers: {
      console: [
        { level: 'error', message: 'TypeError: boom', stack: 'TypeError: boom\n at f (a.js:1:2)', source: 'a.js:1:2', timestamp: '2026-11-23T10:41:58.010Z', count: 2 },
        { level: 'error', message: 'Script error', stack: '', source: '', timestamp: '2026-11-23T10:41:59.010Z', count: 1 },
      ],
      network: [
        { method: 'POST', url: 'https://lumenstays.com/api/bookings/hold', status: 502, durationMs: 1240, timestamp: '2026-11-23T10:41:59.371Z' },
        { method: 'GET', url: 'https://lumenstays.com/api/x', status: 'network-error', durationMs: 3, timestamp: '2026-11-23T10:41:59.400Z' },
        { method: 'GET', url: 'https://lumenstays.com/api/y', status: 'timeout', durationMs: 8000, timestamp: '2026-11-23T10:41:59.500Z' },
      ],
    },
    switches: { console: true, network: true },
    reporter: { id: 'u_8841', name: 'Maya Chen', email: 'maya@lumenstays.com' },
    widgetVersion: '0.1.0',
    ...over,
  };
}

describe('buildReport', () => {
  it('builds a valid report with all six mark kinds and switches on', () => {
    const r = buildReport(state());
    expectValid(r);
    expect(r.schemaVersion).toBe(1);
    expect(r.clientReportId).toMatch(UUID_RE);
    expect(r.project).toBe('lumen');
    expect(r.title).toBe('Book does nothing');
    expect(r.details).toBe('Clicked twice.');
    expect(r.createdAt).toBe('2026-11-23T10:42:17.204Z');
    expect(r.page.viewport).toEqual({ width: 1280, height: 800, devicePixelRatio: 2, scrollX: 0, scrollY: 120 });
    expect(r.screenshot).toEqual({ part: 'screenshot', annotatedPart: 'annotated', width: 2560, height: 1600, scale: 2 });
    expect(r.client).toEqual({ widgetVersion: '0.1.0' });
    expect(r.marks.map((m) => m.kind)).toEqual(['element', 'pin', 'draw', 'text', 'arrow', 'box']);
    expect(r.marks.map((m) => ('n' in m ? m.n : null))).toEqual([1, 2, null, null, null, 3]);
    expect(r.marks[0]).toMatchObject({ note: 'Click does nothing' });
    expect(r.marks[5]).toMatchObject({ note: '' });
    expect(r.console).toHaveLength(2);
    expect(r.console?.[1]).not.toHaveProperty('stack');
    expect(r.network?.map((e) => e.status)).toEqual([502, 'network-error', 'timeout']);
    expect(r.user).toEqual({ id: 'u_8841', name: 'Maya Chen', email: 'maya@lumenstays.com' });
  });

  it('keeps a caller-supplied clientReportId across retries', () => {
    const id = crypto.randomUUID();
    expect(buildReport(state({ clientReportId: id })).clientReportId).toBe(id);
    expect(buildReport(state({ clientReportId: id })).clientReportId).toBe(id);
    expect(buildReport(state()).clientReportId).not.toBe(buildReport(state()).clientReportId);
  });

  it('nulls console and network when switched off', () => {
    const r = buildReport(state({ switches: { console: false, network: false } }));
    expectValid(r);
    expect(r.console).toBeNull();
    expect(r.network).toBeNull();
  });

  it('nulls user for an anonymous reporter and falls back to boxId for project', () => {
    const r = buildReport(state({ reporter: null, config: { boxId: 'ABCDEFGH' } }));
    expectValid(r);
    expect(r.user).toBeNull();
    expect(r.project).toBe('ABCDEFGH');
  });

  it('records a capture error and validates', () => {
    const r = buildReport(state({
      capture: { capturedAt: '2026-11-23T10:42:17.204Z', width: 2560, height: 1600, scale: 2, error: 'E'.repeat(300) },
      marks: [],
    }));
    expectValid(r);
    expect(r.client.captureError).toHaveLength(200);
  });

  it('clips oversized inputs and drops degenerate marks so output still validates', () => {
    const r = buildReport(state({
      draft: { type: 'feature', title: 'x'.repeat(200), details: 'y'.repeat(6000) },
      page: { url: 'https://a.test/', title: '', viewport: { width: 1280.4, height: 799.6, devicePixelRatio: 1.25, scrollX: 3.5, scrollY: 0 } },
      capture: { capturedAt: new Date(), width: 1600.5, height: 999.5, scale: 1.25 },
      marks: [
        { kind: 'box', x: 0, y: 0, w: 4, h: 4, color: '#a83818' },
        { kind: 'draw', points: [[0, 0], [1, 1]], color: '#a83818' },
        { kind: 'text', x: 0, y: 0, text: '   ', color: '#a83818' },
        { kind: 'pin', x: 1, y: 1, color: '#a83818', note: 'z'.repeat(2000) },
      ],
      buffers: {
        console: Array.from({ length: 25 }, (_, i) => ({ level: 'error' as const, message: `m${i}`, stack: '', source: '', timestamp: new Date().toISOString(), count: 1 })),
        network: [],
      },
    }));
    expectValid(r);
    expect(r.marks).toHaveLength(1);
    expect(r.marks[0]).toMatchObject({ kind: 'pin', n: 1 });
    expect(r.console).toHaveLength(20);
    expect(r.console?.[0].message).toBe('m5');
  });
});

describe('buildMultipart', () => {
  it('round-trips three parts through Response.formData()', async () => {
    const report = buildReport(state());
    const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const annotated = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9])], { type: 'image/png' });
    const { body, contentType } = await buildMultipart(report, shot, annotated);
    expect(body).toBeInstanceOf(Uint8Array);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);

    const fd = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    expect([...fd.keys()]).toEqual(['report', 'screenshot', 'annotated']);
    const rep = fd.get('report') as Blob;
    expect(rep.type).toBe('application/json');
    const parsed = JSON.parse(await rep.text());
    expect(parsed).toEqual(report);
    expectValid(parsed);
    const s = fd.get('screenshot') as Blob;
    const a = fd.get('annotated') as Blob;
    expect(s.type).toBe('image/png');
    expect(a.type).toBe('image/png');
    expect(new Uint8Array(await s.arrayBuffer())).toEqual(shot);
    expect(new Uint8Array(await a.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]));
  });
});
