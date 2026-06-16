/**
 * hives.cjs — subagent recipe templates ("Hives").
 *
 * A Recipe is a named sequence of steps, each referencing an agent by name
 * from `~/.claude/agents/<agentName>.md`. Shape:
 *   { slug, name, description, brief?, steps: [{ agentName, note? }] }
 *
 * Legacy hives (old shape: `roles: [{ label, prompt }]`) are migrated on
 * first read: each role is materialized as an agent .md and replaced by a
 * step referencing it. Migration is idempotent and permanent (re-saved).
 *
 * Storage: `~/.claude/session-manager/hives/<slug>.json`
 *   - slug must match SLUG_RE: /^[a-z0-9-_]{1,64}$/
 *   - up to 32 steps per recipe
 *   - per-field byte caps mirrored in the inline zod schemas below
 *
 * IPC namespace (channel names kept for backwards compat):
 *   - hives:list   -> { hives: Recipe[], error: string | null }
 *   - hives:get    -> { hive: Recipe | null, error: string | null }
 *   - hives:save   -> { ok: boolean, error: string | null }
 *   - hives:delete -> { ok: boolean, error: string | null }
 *
 * All mutations go through config.cjs::writeJson / writeTextAtomic (atomic
 * tmp+rename) and config.cjs::validatePath (allowedRoots = home dir).
 * Never raw fs.writeFile.
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
const AGENT_NAME_RE = /^[a-z0-9-_]{1,64}$/;
const MAX_NAME_LEN = 128;
const MAX_DESC_LEN = 2048;
const MAX_BRIEF_LEN = 8 * 1024;
const MAX_NOTE_LEN = 2048;
const MAX_STEPS = 32;

// ──────────────────────────────────────────── inline zod schemas
const recipeStepSchema = z.object({
  agentName: z.string().regex(AGENT_NAME_RE),
  note: z.string().max(MAX_NOTE_LEN).optional(),
}).strict();

const recipeSchema = z.object({
  slug: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(MAX_NAME_LEN),
  description: z.string().max(MAX_DESC_LEN).default(''),
  brief: z.string().max(MAX_BRIEF_LEN).optional(),
  steps: z.array(recipeStepSchema).min(1).max(MAX_STEPS),
}).strict();

const slugPayload = z.object({
  slug: z.string().regex(SLUG_RE),
}).strict();

// Field name "hive" kept for IPC channel backwards compatibility.
const savePayload = z.object({
  slug: z.string().regex(SLUG_RE),
  hive: recipeSchema,
}).strict();

// ──────────────────────────────────────────── paths
function rootDir() {
  return path.join(os.homedir(), '.claude', 'session-manager', 'hives');
}

function agentsDir() {
  return path.join(os.homedir(), '.claude', 'agents');
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

// ──────────────────────────────────────────── helpers
function kebabCase(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'agent';
}

// ──────────────────────────────────────────── legacy migration
async function migrateLegacyHive(slug, raw) {
  const adir = agentsDir();
  await fsp.mkdir(adir, { recursive: true });

  const usedNames = new Set();
  const steps = [];

  for (const role of (raw.roles ?? [])) {
    let base = kebabCase(role.label ?? 'agent');
    let agentName = base;
    let suffix = 2;
    while (usedNames.has(agentName)) {
      agentName = `${base.slice(0, 62)}-${suffix++}`;
    }
    usedNames.add(agentName);

    const agentFilePath = path.join(adir, `${agentName}.md`);
    // validatePath ensures we stay within allowedRoots (home dir).
    const validPath = config.validatePath(agentFilePath);

    let exists = false;
    try { await fsp.stat(validPath); exists = true; } catch { /* ENOENT = not yet created */ }

    if (!exists) {
      const descLine = (role.prompt ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200);
      const content = `---\nname: ${role.label}\ndescription: ${descLine}\n---\n\n${role.prompt ?? ''}\n`;
      await config.writeTextAtomic(validPath, content);
    }

    steps.push({ agentName });
  }

  const recipe = {
    slug,
    name: raw.name,
    description: raw.description ?? '',
    steps,
    ...(raw.defaultPlan ? { brief: raw.defaultPlan } : {}),
  };

  // Persist migrated shape permanently so subsequent reads skip migration.
  await saveHive(slug, recipe);

  return { hive: recipe, error: null };
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

  const raw = r.data;

  // Legacy migration: old shape has `roles` array instead of `steps`.
  if (raw && Array.isArray(raw.roles) && !Array.isArray(raw.steps)) {
    return migrateLegacyHive(slug, raw);
  }

  // Re-validate stored shape so a hand-edited file can't smuggle in bad data.
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) {
    return { hive: null, error: `invalid recipe on disk: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  // Trust the file's own slug only if it matches the filename; filename wins.
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
    // Body slug must match path slug.
    if (hive.slug !== slug) {
      return { ok: false, error: `slug mismatch: payload slug "${hive.slug}" != path "${slug}"` };
    }
    await ensureRoot();
    const abs = hivePath(slug);
    const out = {
      ...hive,
      description: hive.description ?? '',
    };
    if (out.brief === undefined || out.brief === '') delete out.brief;
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
