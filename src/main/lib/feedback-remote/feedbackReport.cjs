// @ts-check
/**
 * feedbackReport — the desktop's validator for a feedback widget Report v1 (the report.json part
 * of the widget's multipart POST). Mirrors web/feedback-widget/schema/report.v1.json exactly:
 * every limit, enum and closed object there is enforced here, and the parity test in
 * __tests__/feedbackReport.test.cjs reads the JSON Schema and compares it with the constants below.
 *
 * Reports come from customers' browsers and are UNTRUSTED. parseReport never throws and its error
 * names only the failing path and the zod issue code — never field contents.
 */
'use strict';

const { z } = require('zod');

const SCHEMA_VERSION = 1;
const REPORT_TYPES = /** @type {const} */ (['bug', 'feature', 'other']);
const MARK_COLORS = /** @type {const} */ (['#a83818', '#f4b942', '#2e5a3e', '#1a1612']);
const MARK_KINDS = /** @type {const} */ (['pin', 'box', 'element', 'arrow', 'draw', 'text']);
const CONSOLE_LEVELS = /** @type {const} */ (['error']);
const CLIENT_REPORT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NETWORK_STATUS_STRINGS = /** @type {const} */ (['network-error', 'timeout']);

const MIN_TITLE = 3;
const MAX_TITLE = 120;
const MAX_DETAILS = 5000;
const MAX_NOTE = 1000;
const MIN_TEXT = 1;
const MAX_TEXT = 140;
const MIN_DRAW_POINTS = 3;
const MIN_BOX_EDGE = 8;
const MIN_MARK_N = 1;
const MAX_ELEMENT_TEXT = 80;
const MAX_CONSOLE = 20;
const MAX_NETWORK = 20;
const MAX_MESSAGE = 500;
const MAX_STACK = 2000;
const MIN_CONSOLE_COUNT = 1;
const MIN_ERROR_STATUS = 400;
const MAX_CAPTURE_ERROR = 200;

/** @type {Record<(typeof REPORT_TYPES)[number], 'bug' | 'feature' | 'discussion'>} */
const INBOX_TAG = { bug: 'bug', feature: 'feature', other: 'discussion' };

const int = () => z.number().int();
const dateTime = () => z.iso.datetime({ offset: true });
const color = z.enum(MARK_COLORS);
const note = z.string().trim().max(MAX_NOTE);
const markN = int().min(MIN_MARK_N);

// $defs
const pin = z.strictObject({ kind: z.literal('pin'), n: markN, x: z.number(), y: z.number(), color, note });
const box = z.strictObject({
  kind: z.literal('box'), n: markN, x: z.number(), y: z.number(),
  w: z.number().min(MIN_BOX_EDGE), h: z.number().min(MIN_BOX_EDGE), color, note,
});
const elementInfo = z.strictObject({
  selector: z.string(),
  label: z.string().optional(),
  tag: z.string(),
  id: z.string().optional(),
  classes: z.array(z.string()).optional(),
  text: z.string().max(MAX_ELEMENT_TEXT).optional(),
  role: z.string().optional(),
  ariaLabel: z.string().optional(),
  xpath: z.string().optional(),
});
const element = z.strictObject({
  kind: z.literal('element'), n: markN, x: z.number(), y: z.number(), w: z.number(), h: z.number(),
  color, note, element: elementInfo,
});
const arrow = z.strictObject({
  kind: z.literal('arrow'), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), color,
});
const draw = z.strictObject({
  kind: z.literal('draw'),
  points: z.array(z.tuple([z.number(), z.number()])).min(MIN_DRAW_POINTS),
  color,
});
const text = z.strictObject({
  kind: z.literal('text'), x: z.number(), y: z.number(), text: z.string().min(MIN_TEXT).max(MAX_TEXT), color,
});
const consoleEntry = z.strictObject({
  level: z.enum(CONSOLE_LEVELS),
  message: z.string().max(MAX_MESSAGE),
  stack: z.string().max(MAX_STACK).optional(),
  source: z.string().optional(),
  timestamp: dateTime(),
  count: int().min(MIN_CONSOLE_COUNT),
});
const networkEntry = z.strictObject({
  method: z.string(),
  url: z.string(),
  status: z.union([int().min(MIN_ERROR_STATUS), z.literal(NETWORK_STATUS_STRINGS[0]), z.literal(NETWORK_STATUS_STRINGS[1])]),
  durationMs: int(),
  timestamp: dateTime(),
});

const mark = z.discriminatedUnion('kind', [pin, box, element, arrow, draw, text]);

const reportSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  // The host's rule (relay + relayBoxesMock UUID_RE): any 8-4-4-4-12 hex, case-insensitive, no
  // version/variant check — so the desktop never rejects a report the host already accepted.
  clientReportId: z.string().regex(CLIENT_REPORT_ID_RE),
  project: z.string(),
  type: z.enum(REPORT_TYPES),
  title: z.string().trim().min(MIN_TITLE).max(MAX_TITLE),
  details: z.string().trim().max(MAX_DETAILS),
  createdAt: dateTime(),
  page: z.strictObject({
    url: z.string(),
    title: z.string(),
    viewport: z.strictObject({
      width: int(), height: int(), devicePixelRatio: z.number(), scrollX: int(), scrollY: int(),
    }),
  }),
  screenshot: z.strictObject({
    part: z.literal('screenshot'),
    annotatedPart: z.literal('annotated'),
    width: int(),
    height: int(),
    scale: z.number(),
  }),
  marks: z.array(mark),
  console: z.array(consoleEntry).max(MAX_CONSOLE).nullable(),
  network: z.array(networkEntry).max(MAX_NETWORK).nullable(),
  user: z.looseObject({ id: z.string(), name: z.string().optional(), email: z.string().optional() }).nullable(),
  client: z.strictObject({
    widgetVersion: z.string(),
    captureError: z.string().max(MAX_CAPTURE_ERROR).optional(),
  }),
});

/**
 * @typedef {z.infer<typeof reportSchema>} Report
 * @typedef {{ ok: true, report: Report } | { ok: false, error: string }} ParseResult
 */

/**
 * Validate an untrusted Report v1 value. Never throws.
 * @param {unknown} value
 * @returns {ParseResult}
 */
function parseReport(value) {
  const r = reportSchema.safeParse(value);
  if (r.success) return { ok: true, report: r.data };
  const issue = r.error.issues[0];
  const where = issue && issue.path.length ? issue.path.map(String).join('.') : '(root)';
  return { ok: false, error: `${where}: ${issue ? issue.code : 'invalid'}` };
}

const MAX_CONTEXT_BYTES = 262144;

/**
 * The structured widget context the host stores opaquely (Bilko 76e88612: <= 262144 bytes of
 * JSON, 413 above). Every part is optional; each part that is present obeys the Report v1 rules.
 */
const contextSchema = z.strictObject({
  page: reportSchema.shape.page.optional(),
  marks: reportSchema.shape.marks.optional(),
  console: reportSchema.shape.console.optional(),
  network: reportSchema.shape.network.optional(),
  client: z.strictObject({
    widgetVersion: z.string().optional(),
    captureError: z.string().max(MAX_CAPTURE_ERROR).optional(),
  }).optional(),
});

/**
 * @typedef {z.infer<typeof contextSchema>} FeedbackContext
 * @typedef {{ ok: true, context: FeedbackContext } | { ok: false, error: string }} ContextResult
 */

/**
 * Validate an untrusted feedback context. Never throws; errors name only the path and issue code.
 * @param {unknown} value
 * @returns {ContextResult}
 */
function parseContext(value) {
  let bytes;
  try {
    const json = JSON.stringify(value);
    bytes = typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    return { ok: false, error: 'context: not serializable' };
  }
  if (bytes > MAX_CONTEXT_BYTES) return { ok: false, error: `context: too_big (over ${MAX_CONTEXT_BYTES} bytes)` };
  const r = contextSchema.safeParse(value);
  if (r.success) return { ok: true, context: r.data };
  const issue = r.error.issues[0];
  const where = issue && issue.path.length ? `context.${issue.path.map(String).join('.')}` : 'context';
  return { ok: false, error: `${where}: ${issue ? issue.code : 'invalid'}` };
}

/**
 * Map a report type to the customer feedback inbox tag.
 * @param {(typeof REPORT_TYPES)[number]} type
 * @returns {'bug' | 'feature' | 'discussion'}
 */
function toInboxTag(type) {
  return INBOX_TAG[type] || 'discussion';
}

module.exports = {
  parseReport,
  parseContext,
  toInboxTag,
  reportSchema,
  contextSchema,
  MAX_CONTEXT_BYTES,
  SCHEMA_VERSION,
  REPORT_TYPES,
  MARK_COLORS,
  MARK_KINDS,
  CONSOLE_LEVELS,
  NETWORK_STATUS_STRINGS,
  MIN_TITLE,
  MAX_TITLE,
  MAX_DETAILS,
  MAX_NOTE,
  MIN_TEXT,
  MAX_TEXT,
  MIN_DRAW_POINTS,
  MIN_BOX_EDGE,
  MIN_MARK_N,
  MAX_ELEMENT_TEXT,
  MAX_CONSOLE,
  MAX_NETWORK,
  MAX_MESSAGE,
  MAX_STACK,
  MIN_CONSOLE_COUNT,
  MIN_ERROR_STATUS,
  MAX_CAPTURE_ERROR,
};
