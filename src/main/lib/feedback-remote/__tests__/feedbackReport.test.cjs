/**
 * feedbackReport.test.cjs — Report v1 validator: example parses, every limit rejects, and the
 * exported constants match web/feedback-widget/schema/report.v1.json.
 *
 * Run: timeout 300 npx vitest run src/main/lib/feedback-remote/__tests__/feedbackReport.test.cjs
 */
'use strict';

import { test, expect, describe } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const fr = require('../feedbackReport.cjs');

const SCHEMA_DIR = path.resolve(__dirname, '../../../../../web/feedback-widget/schema');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'report.v1.json'), 'utf8'));
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, 'report.v1.example.json'), 'utf8'));

/** @returns {any} */
function base() { return structuredClone(EXAMPLE); }
const pin = () => ({ kind: 'pin', n: 1, x: 1, y: 1, color: '#a83818', note: '' });
const box = () => ({ kind: 'box', n: 1, x: 1, y: 1, w: 8, h: 8, color: '#a83818', note: '' });
const text = () => ({ kind: 'text', x: 1, y: 1, text: 'hi', color: '#a83818' });
const draw = () => ({ kind: 'draw', points: [[0, 0], [1, 1], [2, 2]], color: '#a83818' });
const consoleEntry = () => ({ level: 'error', message: 'm', timestamp: '2026-11-23T10:41:58.010Z', count: 1 });
const netEntry = () => ({ method: 'GET', url: 'https://x.test/a', status: 500, durationMs: 1, timestamp: '2026-11-23T10:41:58.010Z' });

describe('parseReport accepts', () => {
  test('the published example', () => {
    const r = fr.parseReport(base());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.report.clientReportId).toBe(EXAMPLE.clientReportId);
  });
  test('boundary values and nullable lists', () => {
    const v = base();
    v.title = '  abc  ';
    v.console = null; v.network = null; v.user = null;
    v.client.captureError = 'x'.repeat(200);
    v.marks = [pin(), box(), text(), draw()];
    v.marks[0].note = 'n'.repeat(1000);
    v.marks[2].text = 't'.repeat(140);
    const r = fr.parseReport(v);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.title).toBe('abc');
  });
  test('network status strings and user extra props', () => {
    const v = base();
    v.network = [{ ...netEntry(), status: 'network-error' }, { ...netEntry(), status: 'timeout' }, { ...netEntry(), status: 400 }];
    v.user = { id: 'u', plan: 'pro' };
    expect(fr.parseReport(v).ok).toBe(true);
  });
});

/** @type {Array<[string, (v: any) => void, string]>} */
const MUTATIONS = [
  ['schemaVersion 2', (v) => { v.schemaVersion = 2; }, 'schemaVersion'],
  ['clientReportId not uuid', (v) => { v.clientReportId = 'not-a-uuid'; }, 'clientReportId'],
  ['clientReportId non-RFC GUID (version 0, variant 0)', (v) => { v.clientReportId = '01234567-89ab-0def-0123-456789abcdef'; }, 'clientReportId'],
  ['type unknown', (v) => { v.type = 'praise'; }, 'type'],
  ['title too short after trim', (v) => { v.title = '  ab  '; }, 'title'],
  ['title too long', (v) => { v.title = 'x'.repeat(121); }, 'title'],
  ['details too long', (v) => { v.details = 'x'.repeat(5001); }, 'details'],
  ['mark note too long', (v) => { v.marks = [{ ...pin(), note: 'x'.repeat(1001) }]; }, 'marks.0.note'],
  ['text mark empty', (v) => { v.marks = [{ ...text(), text: '' }]; }, 'marks.0.text'],
  ['text mark too long', (v) => { v.marks = [{ ...text(), text: 'x'.repeat(141) }]; }, 'marks.0.text'],
  ['draw < 3 points', (v) => { v.marks = [{ ...draw(), points: [[0, 0], [1, 1]] }]; }, 'marks.0.points'],
  ['draw point not a pair', (v) => { v.marks = [{ ...draw(), points: [[0, 0], [1, 1], [2]] }]; }, 'marks.0.points.2'],
  ['box w < 8', (v) => { v.marks = [{ ...box(), w: 7 }]; }, 'marks.0.w'],
  ['box h < 8', (v) => { v.marks = [{ ...box(), h: 7.9 }]; }, 'marks.0.h'],
  ['mark color off palette', (v) => { v.marks = [{ ...pin(), color: '#ffffff' }]; }, 'marks.0.color'],
  ['mark kind unknown', (v) => { v.marks = [{ ...pin(), kind: 'circle' }]; }, 'marks.0.kind'],
  ['pin n < 1', (v) => { v.marks = [{ ...pin(), n: 0 }]; }, 'marks.0.n'],
  ['console > 20', (v) => { v.console = Array.from({ length: 21 }, consoleEntry); }, 'console'],
  ['network > 20', (v) => { v.network = Array.from({ length: 21 }, netEntry); }, 'network'],
  ['console message too long', (v) => { v.console = [{ ...consoleEntry(), message: 'x'.repeat(501) }]; }, 'console.0.message'],
  ['console stack too long', (v) => { v.console = [{ ...consoleEntry(), stack: 'x'.repeat(2001) }]; }, 'console.0.stack'],
  ['console level warn', (v) => { v.console = [{ ...consoleEntry(), level: 'warn' }]; }, 'console.0.level'],
  ['console count 0', (v) => { v.console = [{ ...consoleEntry(), count: 0 }]; }, 'console.0.count'],
  ['network status 399', (v) => { v.network = [{ ...netEntry(), status: 399 }]; }, 'network.0.status'],
  ['network status float', (v) => { v.network = [{ ...netEntry(), status: 500.5 }]; }, 'network.0.status'],
  ['network status other string', (v) => { v.network = [{ ...netEntry(), status: 'aborted' }]; }, 'network.0.status'],
  ['captureError too long', (v) => { v.client.captureError = 'x'.repeat(201); }, 'client.captureError'],
  ['extra top-level prop', (v) => { v.secret = 1; }, ''],
  ['extra page prop', (v) => { v.page.extra = 1; }, 'page'],
  ['extra viewport prop', (v) => { v.page.viewport.extra = 1; }, 'page.viewport'],
  ['extra screenshot prop', (v) => { v.screenshot.extra = 1; }, 'screenshot'],
  ['screenshot part renamed', (v) => { v.screenshot.part = 'raw'; }, 'screenshot.part'],
  ['extra mark prop', (v) => { v.marks = [{ ...pin(), extra: 1 }]; }, 'marks.0'],
  ['extra element prop', (v) => { v.marks[0].element.extra = 1; }, 'marks.0.element'],
  ['element text too long', (v) => { v.marks[0].element.text = 'x'.repeat(81); }, 'marks.0.element.text'],
  ['extra console prop', (v) => { v.console = [{ ...consoleEntry(), extra: 1 }]; }, 'console.0'],
  ['extra network prop', (v) => { v.network = [{ ...netEntry(), extra: 1 }]; }, 'network.0'],
  ['extra client prop', (v) => { v.client.extra = 1; }, 'client'],
  ['user without id', (v) => { v.user = { name: 'x' }; }, 'user.id'],
  ['missing createdAt', (v) => { delete v.createdAt; }, 'createdAt'],
  ['createdAt not date-time', (v) => { v.createdAt = 'yesterday'; }, 'createdAt'],
  ['viewport width float', (v) => { v.page.viewport.width = 1.5; }, 'page.viewport.width'],
];

describe('parseReport rejects', () => {
  for (const [name, mutate, wantPath] of MUTATIONS) {
    test(name, () => {
      const v = base();
      mutate(v);
      const r = fr.parseReport(v);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const shown = r.error.split(':')[0];
        expect(shown).toBe(wantPath === '' ? '(root)' : wantPath);
      }
    });
  }
  test('non-object input', () => {
    for (const v of [null, undefined, 'x', 3, []]) expect(fr.parseReport(v).ok).toBe(false);
  });
  test('error never echoes field contents', () => {
    const v = base();
    v.type = 'SECRET-TOKEN-abc123';
    v.title = 'SECRET-TITLE-'.repeat(20);
    const r = fr.parseReport(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/SECRET/);
  });
});

describe('toInboxTag', () => {
  test('maps report types to inbox tags', () => {
    expect(fr.toInboxTag('bug')).toBe('bug');
    expect(fr.toInboxTag('feature')).toBe('feature');
    expect(fr.toInboxTag('other')).toBe('discussion');
  });
});

describe('parity with report.v1.json', () => {
  const D = SCHEMA.$defs;
  const P = SCHEMA.properties;
  test('enums', () => {
    expect(fr.REPORT_TYPES).toEqual(P.type.enum);
    expect(fr.MARK_COLORS).toEqual(D.color.enum);
    const kinds = P.marks.items.oneOf.map((/** @type {{$ref: string}} */ r) => D[r.$ref.split('/').pop()].properties.kind.const);
    expect(fr.MARK_KINDS).toEqual(kinds);
    expect(fr.CONSOLE_LEVELS).toEqual(D.consoleEntry.properties.level.enum);
    expect(fr.NETWORK_STATUS_STRINGS).toEqual(D.networkEntry.properties.status.oneOf.filter((/** @type {any} */ s) => 'const' in s).map((/** @type {any} */ s) => s.const));
    expect(fr.SCHEMA_VERSION).toBe(P.schemaVersion.const);
  });
  test('numeric limits', () => {
    expect(fr.MIN_TITLE).toBe(P.title.minLength);
    expect(fr.MAX_TITLE).toBe(P.title.maxLength);
    expect(fr.MAX_DETAILS).toBe(P.details.maxLength);
    expect(fr.MAX_NOTE).toBe(D.note.maxLength);
    expect(fr.MIN_TEXT).toBe(D.text.properties.text.minLength);
    expect(fr.MAX_TEXT).toBe(D.text.properties.text.maxLength);
    expect(fr.MIN_DRAW_POINTS).toBe(D.draw.properties.points.minItems);
    expect(fr.MIN_BOX_EDGE).toBe(D.box.properties.w.minimum);
    expect(fr.MIN_BOX_EDGE).toBe(D.box.properties.h.minimum);
    expect(fr.MIN_MARK_N).toBe(D.pin.properties.n.minimum);
    expect(fr.MAX_ELEMENT_TEXT).toBe(D.element.properties.element.properties.text.maxLength);
    expect(fr.MAX_CONSOLE).toBe(P.console.oneOf[1].maxItems);
    expect(fr.MAX_NETWORK).toBe(P.network.oneOf[1].maxItems);
    expect(fr.MAX_MESSAGE).toBe(D.consoleEntry.properties.message.maxLength);
    expect(fr.MAX_STACK).toBe(D.consoleEntry.properties.stack.maxLength);
    expect(fr.MIN_CONSOLE_COUNT).toBe(D.consoleEntry.properties.count.minimum);
    expect(fr.MIN_ERROR_STATUS).toBe(D.networkEntry.properties.status.oneOf[0].minimum);
    expect(fr.MAX_CAPTURE_ERROR).toBe(P.client.properties.captureError.maxLength);
  });
  test('strict objects match additionalProperties:false', () => {
    // Every object the JSON Schema closes is one the zod schema closes (spot-checked above);
    // here assert the JSON Schema still closes the set we rely on.
    for (const o of [SCHEMA, P.page, P.page.properties.viewport, P.screenshot, P.client, D.pin, D.box, D.element,
      D.element.properties.element, D.arrow, D.draw, D.text, D.consoleEntry, D.networkEntry]) {
      expect(o.additionalProperties).toBe(false);
    }
    expect(P.user.oneOf[1].additionalProperties).toBe(true);
  });
});
