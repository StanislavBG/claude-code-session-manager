/**
 * hives.cjs — pre-baked subagent swarm templates ("Hives").
 *
 * A Hive is a named collection of subagent roles + an optional default plan,
 * launchable as one unit. Concept ported from ClaudeCodeUnleashed; our shape
 * is `{ slug, name, description, roles: [{ label, prompt }], defaultPlan? }`
 * (renderer launches by configuring Orchestrator with those roles).
 *
 * Storage: `~/.claude/session-manager/hives/<slug>.json`
 *   - slug must match SLUG_RE: /^[a-z0-9-_]{1,64}$/
 *   - up to 32 roles per hive
 *   - per-field byte caps mirrored in the inline zod schemas below
 *
 * IPC namespace:
 *   - hives:list   -> { hives: Hive[], error: string | null }
 *   - hives:get    -> { hive: Hive | null, error: string | null }
 *   - hives:save   -> { ok: boolean, error: string | null }
 *   - hives:delete -> { ok: boolean, error: string | null }
 *
 * All mutations go through config.cjs::writeJson (atomic tmp+rename) and
 * config.cjs::validatePath (allowedRoots = home dir). Never raw fs.writeFile.
 *
 * Default hives (Code review / Build feature / Bug hunt) ship in the renderer
 * (src/renderer/lib/defaultHives.ts) and are NOT writable to disk — they exist
 * only as in-memory starter examples so a fresh install has content. The IPC
 * layer only sees user-saved hives.
 */

'use strict';

const { ipcMain } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { z } = require('zod');
const config = require('./config.cjs');

// ──────────────────────────────────────────── caps
const SLUG_RE = /^[a-z0-9-_]{1,64}$/;
const MAX_NAME_LEN = 128;
const MAX_DESC_LEN = 2048;
const MAX_LABEL_LEN = 128;
const MAX_PROMPT_LEN = 16 * 1024;
const MAX_PLAN_LEN = 8 * 1024;
const MAX_ROLES = 32;

// ──────────────────────────────────────────── inline zod schemas
const hiveRoleSchema = z.object({
  label: z.string().min(1).max(MAX_LABEL_LEN),
  prompt: z.string().min(1).max(MAX_PROMPT_LEN),
}).strict();

const hiveSchema = z.object({
  slug: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(MAX_NAME_LEN),
  description: z.string().max(MAX_DESC_LEN).default(''),
  roles: z.array(hiveRoleSchema).min(1).max(MAX_ROLES),
  defaultPlan: z.string().max(MAX_PLAN_LEN).optional(),
}).strict();

const slugPayload = z.object({
  slug: z.string().regex(SLUG_RE),
}).strict();

const savePayload = z.object({
  slug: z.string().regex(SLUG_RE),
  hive: hiveSchema,
}).strict();

// ──────────────────────────────────────────── paths
function rootDir() {
  return path.join(os.homedir(), '.claude', 'session-manager', 'hives');
}

function hivePath(slug) {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid hive slug (must match ${SLUG_RE.source})`);
  }
  return path.join(rootDir(), `${slug}.json`);
}

async function ensureRoot() {
  await fsp.mkdir(rootDir(), { recursive: true });
}

// ──────────────────────────────────────────── core ops
async function listHives() {
  try {
    await ensureRoot();
    const r = await config.listDir(rootDir(), { filesOnly: true });
    if (!r.ok) return { hives: [], error: r.error };
    const slugs = r.entries
      .filter((e) => e.name.endsWith('.json'))
      .map((e) => e.name.replace(/\.json$/, ''))
      .filter((s) => SLUG_RE.test(s));
    // Load each in parallel. Skip any that fail to parse cleanly.
    const hives = await Promise.all(
      slugs.map(async (slug) => {
        try {
          const got = await readHive(slug);
          return got.hive;
        } catch {
          return null;
        }
      }),
    );
    return {
      hives: hives.filter((h) => h !== null).sort((a, b) => a.slug.localeCompare(b.slug)),
      error: null,
    };
  } catch (e) {
    return { hives: [], error: e.message };
  }
}

async function readHive(slug) {
  const abs = hivePath(slug);
  const r = await config.readJson(abs);
  if (!r || !r.exists) return { hive: null, error: null };
  if (r.parseError) return { hive: null, error: `parse error: ${r.parseError}` };
  // Re-validate stored shape so a hand-edited file can't smuggle in bad data.
  const parsed = hiveSchema.safeParse(r.data);
  if (!parsed.success) {
    return { hive: null, error: `invalid hive on disk: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  // Trust the file's own slug only if it matches the filename; otherwise force
  // them to agree (filename wins — that's the storage key).
  const hive = { ...parsed.data, slug };
  return { hive, error: null };
}

async function getHive(slug) {
  try {
    return await readHive(slug);
  } catch (e) {
    return { hive: null, error: e.message };
  }
}

async function saveHive(slug, hive) {
  try {
    // Body slug must match path slug. Reject mismatches loudly so the renderer
    // can't accidentally overwrite the wrong file by tampering with `slug`.
    if (hive.slug !== slug) {
      return { ok: false, error: `slug mismatch: payload slug "${hive.slug}" != path "${slug}"` };
    }
    await ensureRoot();
    const abs = hivePath(slug);
    const out = {
      ...hive,
      // Strip undefined for clean JSON on disk.
      description: hive.description ?? '',
    };
    if (out.defaultPlan === undefined || out.defaultPlan === '') delete out.defaultPlan;
    const result = await config.writeJson(abs, out);
    if (!result || !result.ok) {
      return { ok: false, error: result?.error ?? 'write failed' };
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function deleteHive(slug) {
  try {
    const abs = hivePath(slug);
    let real;
    try {
      real = config.validatePath(abs);
      if (typeof config.validateWrite === 'function') {
        config.validateWrite(real);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
    try {
      await fsp.unlink(real);
    } catch (e) {
      if (e.code === 'ENOENT') {
        // Treat missing as success — idempotent delete, same as fs unlink ENOENT.
        return { ok: true, error: null };
      }
      return { ok: false, error: e.message };
    }
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ──────────────────────────────────────────── IPC
function validated(schema, handler) {
  return (_event, payload) => {
    const parsed = schema.parse(payload);
    return handler(parsed);
  };
}

function registerHiveHandlers() {
  ipcMain.handle('hives:list', () => listHives());
  ipcMain.handle(
    'hives:get',
    validated(slugPayload, ({ slug }) => getHive(slug)),
  );
  ipcMain.handle(
    'hives:save',
    validated(savePayload, ({ slug, hive }) => saveHive(slug, hive)),
  );
  ipcMain.handle(
    'hives:delete',
    validated(slugPayload, ({ slug }) => deleteHive(slug)),
  );
}

module.exports = {
  registerHiveHandlers,
  // exported for tests
  rootDir,
  hivePath,
  SLUG_RE,
  listHives,
  getHive,
  saveHive,
  deleteHive,
};
