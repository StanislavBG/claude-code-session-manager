'use strict';

/**
 * needsYouStore.cjs — machine-level store of "Needs you" items: questions an
 * outside app on this machine needs the owner to decide, so they can show in
 * the Dashboard's Needs you list instead of one inbox per app.
 *
 * File: schedulerHome()/needs-you.json = { version: 1, items }.
 * Writes are atomic (writeJsonAtomic) and serialized through one queue.
 * A missing or corrupt file reads as empty; a corrupt file is set aside as
 * `needs-you.json.corrupt-<ms>` at the next write. Answered or withdrawn items
 * older than 14 days are dropped at the next write.
 */

const fsp = require('node:fs/promises');
const { z } = require('zod');
const { writeJsonAtomic } = require('../util/atomicFs.cjs');
const { needsYouPath } = require('../scheduler/schedulerPaths.cjs');
const { normalizeExternalRef } = require('../epic/externalRef.cjs');

const STORE_VERSION = 1;
const MAX_OPEN_PER_APP = 10;
const MAX_OPEN_TOTAL = 50;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const STATUSES = /** @type {const} */ (['open', 'answered', 'withdrawn']);

const AppSchema = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/, 'app must be 1 to 40 letters, digits, . _ or -');

/**
 * Runs a value through normalizeExternalRef; `required` refuses absent values.
 * The input is `.optional()` so zod 4 lets a missing key reach the transform
 * (a bare z.unknown().transform() rejects it as "expected nonoptional").
 */
function refSchema(label, required) {
  return z.unknown().optional().transform((v, ctx) => {
    if (required && (v === undefined || v === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is required.` });
      return z.NEVER;
    }
    const r = normalizeExternalRef(v);
    if (!r.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.error.replace(/^externalRef/, label) });
      return z.NEVER;
    }
    return r.value;
  });
}

const TitleSchema = z.string().min(1).max(200).refine((s) => !/[\r\n]/.test(s), 'title must be one line');
const WhySchema = z.string().max(1000);
const LinkSchema = z.string().max(2000).regex(/^https?:\/\//, 'link must start with http:// or https://');
const OptionsSchema = z.array(z.string().min(1).max(80)).min(2).max(5)
  .refine((opts) => new Set(opts).size === opts.length, 'options must be distinct');

const NeedsYouPostSchema = z.object({
  app: AppSchema,
  id: refSchema('id', true),
  title: TitleSchema,
  why: WhySchema.optional(),
  link: LinkSchema.optional(),
  options: OptionsSchema.optional(),
  externalRef: refSchema('externalRef', false),
});

const KeySchema = z.object({ app: AppSchema, id: refSchema('id', true) });

const StoredItemSchema = z.object({
  app: AppSchema,
  id: z.string().min(1),
  title: TitleSchema,
  why: z.string(),
  link: LinkSchema.nullable(),
  options: OptionsSchema.nullable(),
  externalRef: z.string().nullable(),
  status: z.enum(STATUSES),
  answer: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  answeredAt: z.string().nullable(),
});

/** @typedef {z.infer<typeof StoredItemSchema>} NeedsYouItem */

// --- serialized writes ------------------------------------------------------

let writeChain = Promise.resolve();
/** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
function serialize(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

// --- read / write -----------------------------------------------------------

/** Returns { state: 'missing'|'corrupt'|'unreadable'|'ok', items }. Never throws. */
async function readStore(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', items: [] };
    console.warn(`[needsYouStore] cannot read ${filePath}:`, err && err.message);
    return { state: 'unreadable', items: [] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'corrupt', items: [] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'corrupt', items: [] };
  const list = Array.isArray(raw.items) ? raw.items : [];
  const items = [];
  const seen = new Set();
  let dropped = 0;
  for (const entry of list) {
    const r = StoredItemSchema.safeParse(entry);
    const key = r.success ? `${r.data.app}\u0000${r.data.id}` : '';
    if (r.success && !seen.has(key)) {
      seen.add(key);
      items.push(r.data);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) console.warn(`[needsYouStore] dropped ${dropped} invalid item(s) from ${filePath}`);
  return { state: 'ok', items };
}

/** Load for a write. MUST run inside serialize. Sets a corrupt file aside. */
async function loadForWrite(filePath) {
  const cur = await readStore(filePath);
  if (cur.state === 'unreadable') throw new Error(`needs-you store is unreadable: ${filePath}`);
  if (cur.state === 'corrupt') {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    await fsp.rename(filePath, quarantine);
    console.warn(`[needsYouStore] ${filePath} is unparseable; preserved as ${quarantine}`);
  }
  return cur.items;
}

function prune(items, nowMs) {
  return items.filter((it) => {
    if (it.status === 'open') return true;
    const closedAt = Date.parse(it.answeredAt || it.updatedAt);
    return !(Number.isFinite(closedAt) && nowMs - closedAt > RETENTION_MS);
  });
}

async function writeStore(filePath, items) {
  await writeJsonAtomic(filePath, { version: STORE_VERSION, items: prune(items, Date.now()) });
}

function limitError(message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = 'NEEDS_YOU_LIMIT';
  return err;
}

// --- public API ---------------------------------------------------------------

/**
 * @param {{ app?: string, status?: string }} [filter]
 * @returns {Promise<NeedsYouItem[]>}
 */
async function listNeedsYou(filter = {}) {
  const { app, status } = filter || {};
  const { items } = await readStore(needsYouPath());
  return items.filter((it) => (app === undefined || it.app === app) && (status === undefined || it.status === status));
}

/** The caller fields a post may set on an open item. */
function callerKey(item) {
  return JSON.stringify([item.title, item.why, item.link, item.options, item.externalRef]);
}

/**
 * Create an open item, or replace title/why/link/options/externalRef of an
 * existing open item with the same app + id (a left-out field is cleared).
 * A closed item is returned unchanged. `changed` is decided inside the write
 * queue: true on create or when a stored field differs; an identical re-post
 * writes nothing and keeps updatedAt.
 * @param {unknown} input
 * @returns {Promise<{ item: NeedsYouItem, created: boolean, changed: boolean }>}
 */
async function postNeedsYou(input) {
  const data = NeedsYouPostSchema.parse(input);
  const filePath = needsYouPath();
  return serialize(async () => {
    const items = await loadForWrite(filePath);
    const now = new Date().toISOString();
    const existing = items.find((it) => it.app === data.app && it.id === data.id);
    if (existing) {
      if (existing.status !== 'open') return { item: existing, created: false, changed: false };
      const before = callerKey(existing);
      existing.title = data.title;
      existing.why = data.why ?? '';
      existing.link = data.link ?? null;
      existing.options = data.options ?? null;
      existing.externalRef = data.externalRef ?? null;
      if (callerKey(existing) === before) return { item: existing, created: false, changed: false };
      existing.updatedAt = now;
      await writeStore(filePath, items);
      return { item: existing, created: false, changed: true };
    }
    const open = items.filter((it) => it.status === 'open');
    if (open.filter((it) => it.app === data.app).length >= MAX_OPEN_PER_APP) {
      throw limitError(`${data.app} already has ${MAX_OPEN_PER_APP} open Needs you items.`);
    }
    if (open.length >= MAX_OPEN_TOTAL) {
      throw limitError(`There are already ${MAX_OPEN_TOTAL} open Needs you items.`);
    }
    /** @type {NeedsYouItem} */
    const item = {
      app: data.app,
      id: /** @type {string} */ (data.id),
      title: data.title,
      why: data.why ?? '',
      link: data.link ?? null,
      options: data.options ?? null,
      externalRef: data.externalRef ?? null,
      status: 'open',
      answer: null,
      createdAt: now,
      updatedAt: now,
      answeredAt: null,
    };
    items.push(item);
    await writeStore(filePath, items);
    return { item, created: true, changed: true };
  });
}

/** Apply `mutate` to the open item app+id; returns it, or null when none / mutate refuses. */
async function updateOpen(app, id, mutate) {
  const key = KeySchema.parse({ app, id });
  const filePath = needsYouPath();
  return serialize(async () => {
    const items = await loadForWrite(filePath);
    const item = items.find((it) => it.app === key.app && it.id === key.id);
    if (!item || item.status !== 'open') return null;
    const now = new Date().toISOString();
    if (!mutate(item, now)) return null;
    item.updatedAt = now;
    await writeStore(filePath, items);
    return item;
  });
}

/**
 * @param {{ app: string, id: string }} args
 * @returns {Promise<NeedsYouItem | null>}
 */
async function withdrawNeedsYou({ app, id }) {
  return updateOpen(app, id, (item) => {
    item.status = 'withdrawn';
    return true;
  });
}

/**
 * @param {{ app: string, id: string, answer: string }} args
 * @returns {Promise<NeedsYouItem | null>}
 */
async function answerNeedsYou({ app, id, answer }) {
  return updateOpen(app, id, (item, now) => {
    if (!item.options || typeof answer !== 'string' || !item.options.includes(answer)) return false;
    item.status = 'answered';
    item.answer = answer;
    item.answeredAt = now;
    return true;
  });
}

module.exports = {
  NeedsYouPostSchema,
  listNeedsYou,
  postNeedsYou,
  withdrawNeedsYou,
  answerNeedsYou,
  MAX_OPEN_PER_APP,
  MAX_OPEN_TOTAL,
  RETENTION_MS,
};
