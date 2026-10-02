'use strict';

/**
 * macroLibrary.cjs — the global, machine-local Macro library.
 *
 * A Macro is a one-click sidebar "HOT KEYS" button that starts a new session
 * with a preset Agent + Tag + Initial Prompt (e.g. label "Build the Project",
 * agent `builder`, tag `build`, prompt "Build and publish this project").
 * Each macro lists which projects show it.
 *
 * Store: `~/.claude/session-manager/macros.json`, `{ version: 1, macros: Macro[] }`.
 * The path is fixed; every exported function accepts an optional
 * `{ filePath }` ONLY so tests can inject a temp file — IPC handlers never
 * forward renderer input as a path.
 *
 * Reads are tolerant: invalid entries are dropped individually (one
 * console.warn per read). A missing file triggers the one-time migration. An
 * UNPARSEABLE file is never treated as missing: it is renamed to
 * `macros.json.corrupt-<timestamp>` (kept for recovery), a warning is logged,
 * and a fresh empty store is written WITHOUT re-running migration.
 * Writes go through writeJsonAtomic and are serialized by an in-module
 * promise chain so concurrent saves never clobber each other.
 *
 * One-time migration: when macros.json does not exist, listMacros seeds it
 * from the retired Agent Library persona frontmatter (`action:`,
 * `actionLabel:`, `projects:`). On success the file is written (even with
 * `macros: []`) so migration never reruns; if listing personas throws, nothing
 * is written and the next call retries.
 *
 * `projects` entries are absolute project cwds or the literal '*' (every
 * project). setMacroProject cannot narrow a '*' macro: it returns
 * `{ ok: false, error: 'macro is shown in every project' }`.
 *
 * Plain Node, no Electron imports.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { z } = require('zod');
const { writeJsonAtomic } = require('./atomicFs.cjs');
const { EpicTagSchema } = require('./promptSessionSchema.cjs');
const { WORK_TYPES } = require('./workTypeLibrary.cjs');
const { PERSONA_NAME_RE } = require('./personaMerge.cjs');
const { schedulerHome } = require('./schedulerPaths.cjs');

const ALL_PROJECTS = '*';
const STORE_VERSION = 1;

const MacroIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid macro id');
const MacroLabelSchema = z.string().trim().min(1).max(60);
const MacroAgentNameSchema = z.string().regex(PERSONA_NAME_RE, 'agent name must be lowercase, hyphenated (e.g. "my-agent")');
const MacroPromptSchema = z.string().trim().min(1).max(8000);
const AbsolutePathSchema = z.string().max(1024).refine(
  (v) => !v.includes('\0') && path.isAbsolute(v),
  'must be an absolute path',
);
const MacroProjectEntrySchema = z.union([z.literal(ALL_PROJECTS), AbsolutePathSchema]);
const MacroProjectsSchema = z.array(MacroProjectEntrySchema).max(200);

const MacroSchema = z.object({
  id: MacroIdSchema,
  label: MacroLabelSchema,
  agentName: MacroAgentNameSchema,
  tag: EpicTagSchema,
  prompt: MacroPromptSchema,
  projects: MacroProjectsSchema,
  createdAt: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
});

const MacroSaveSchema = z.object({
  id: MacroIdSchema.optional(),
  label: MacroLabelSchema,
  agentName: MacroAgentNameSchema,
  tag: EpicTagSchema,
  prompt: MacroPromptSchema,
  projects: MacroProjectsSchema.default([]),
});

const MacroDeleteSchema = z.object({ id: MacroIdSchema });

const MacroSetProjectSchema = z.object({
  id: MacroIdSchema,
  cwd: AbsolutePathSchema,
  enabled: z.boolean(),
});

function defaultFilePath() {
  return path.join(schedulerHome(), 'macros.json');
}

function resolvePath(opts) {
  return (opts && opts.filePath) || defaultFilePath();
}

/**
 * Canonical cwd form. MUST match the renderer's `normalizeCwd`
 * (src/renderer/lib/knownProjectAggregate.ts): trim, collapse repeated `/`,
 * strip trailing `/` (root stays `/`). '*' passes through.
 */
function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === ALL_PROJECTS) return cwd;
  const collapsed = cwd.trim().replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/, '');
}

function normalizeProjects(projects) {
  const out = [];
  for (const p of projects || []) {
    const n = normalizeCwd(p);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function slugify(label) {
  const s = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/g, '');
  return s || 'macro';
}

function newId(label, taken) {
  for (let i = 0; i < 20; i++) {
    const id = `${slugify(label)}-${crypto.randomBytes(3).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
  return `${slugify(label)}-${crypto.randomUUID()}`.slice(0, 64);
}

// --- serialized writes ------------------------------------------------------

let writeChain = Promise.resolve();
function serialize(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

// --- read -------------------------------------------------------------------

/**
 * Pure read. Returns `{ state: 'missing' | 'corrupt' | 'unreadable' | 'ok', macros }`.
 * 'corrupt' = file exists but is not a JSON object; 'unreadable' = any other fs error.
 */
async function readStore(filePath) {
  let text;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', macros: [] };
    console.warn(`[macroLibrary] cannot read ${filePath}:`, err && err.message);
    return { state: 'unreadable', macros: [] };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'corrupt', macros: [] };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'corrupt', macros: [] };
  const list = Array.isArray(raw.macros) ? raw.macros : [];
  const macros = [];
  let dropped = 0;
  const seen = new Set();
  for (const entry of list) {
    const normalized = entry && typeof entry === 'object' && Array.isArray(entry.projects)
      ? { ...entry, projects: normalizeProjects(entry.projects) }
      : entry;
    const r = MacroSchema.safeParse(normalized);
    if (r.success && !seen.has(r.data.id)) {
      seen.add(r.data.id);
      macros.push(r.data);
    } else {
      dropped++;
    }
  }
  if (dropped > 0 || !Array.isArray(raw.macros)) {
    console.warn(`[macroLibrary] dropped ${dropped} invalid macro entr${dropped === 1 ? 'y' : 'ies'} from ${filePath}`);
  }
  return { state: 'ok', macros };
}

async function writeStore(filePath, macros) {
  await writeJsonAtomic(filePath, { version: STORE_VERSION, macros });
}

// --- migration --------------------------------------------------------------

function isValidProject(p) {
  return p === ALL_PROJECTS || AbsolutePathSchema.safeParse(p).success;
}

function personasToMacros(personas, now) {
  const macros = [];
  const taken = new Set();
  for (const p of personas || []) {
    if (!p || typeof p.name !== 'string') continue;
    const declared = Array.isArray(p.projects) ? p.projects.filter((x) => typeof x === 'string' && x.trim()) : [];
    const normalized = normalizeProjects(declared);
    const projects = normalized.filter(isValidProject);
    const skipped = normalized.filter((x) => !isValidProject(x));
    if (skipped.length > 0) {
      console.warn(`[macroLibrary] persona "${p.name}": skipped non-absolute project entries: ${skipped.join(', ')}`);
    }
    const prompt = (p.action && String(p.action).trim()) || (p.description && String(p.description).trim()) || '';
    if (projects.length === 0 || !prompt) continue;
    // First persona tag in canonical TAG_LIBRARY order (WORK_TYPES mirrors it), else 'discussion'.
    const personaTags = Array.isArray(p.tags) ? p.tags : [];
    const tag = WORK_TYPES.find((t) => personaTags.includes(t)) || 'discussion';
    const label = String(p.actionLabel || p.name).trim().slice(0, 60);
    const candidate = {
      id: newId(label, taken),
      label,
      agentName: p.name,
      tag,
      prompt: prompt.slice(0, 8000),
      projects,
      createdAt: now,
      updatedAt: now,
    };
    const r = MacroSchema.safeParse(candidate);
    if (!r.success) continue;
    taken.add(r.data.id);
    macros.push(r.data);
  }
  return macros;
}

/** Returns the migrated macros, or `null` on failure (caller must NOT write). */
async function migrateFromPersonas(opts) {
  try {
    const listPersonas = (opts && opts.listPersonas) || require('../agentLibrary.cjs').listPersonas;
    const personas = await listPersonas();
    return personasToMacros(personas, new Date().toISOString());
  } catch (err) {
    console.warn('[macroLibrary] persona migration failed; will retry on next call:', err && err.message);
    return null;
  }
}

/**
 * Load the store, repairing it as needed. MUST run inside `serialize`.
 * Returns `{ macros, failed }`; `failed` means nothing was persisted and the
 * caller must not write (migration failed / file unreadable / quarantine failed).
 */
async function loadStore(filePath, opts) {
  const cur = await readStore(filePath);
  if (cur.state === 'ok') return { macros: cur.macros, failed: false };
  if (cur.state === 'unreadable') return { macros: [], failed: true };
  if (cur.state === 'corrupt') {
    const quarantine = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fsp.rename(filePath, quarantine);
    } catch (err) {
      console.warn(`[macroLibrary] ${filePath} is unparseable and could not be preserved:`, err && err.message);
      return { macros: [], failed: true };
    }
    console.warn(`[macroLibrary] ${filePath} is unparseable; preserved as ${quarantine}, starting with an empty library`);
    try {
      await writeStore(filePath, []);
    } catch (err) {
      console.warn('[macroLibrary] could not write fresh macros.json:', err && err.message);
      return { macros: [], failed: true };
    }
    return { macros: [], failed: false };
  }
  // missing: migrate once
  const seeded = await migrateFromPersonas(opts);
  if (seeded === null) return { macros: [], failed: true };
  try {
    await writeStore(filePath, seeded);
  } catch (err) {
    console.warn('[macroLibrary] could not write migrated macros.json:', err && err.message);
    return { macros: seeded, failed: true };
  }
  return { macros: seeded, failed: false };
}

// --- public API -------------------------------------------------------------

/** @returns {Promise<Macro[]>} */
async function listMacros(opts = {}) {
  const filePath = resolvePath(opts);
  const first = await readStore(filePath);
  if (first.state === 'ok') return first.macros;
  // Missing/corrupt: repair inside the write chain so racing callers don't double-seed.
  return serialize(async () => (await loadStore(filePath, opts)).macros);
}

/** Load for a write; refuse to write over a store that could not be loaded. */
async function loadForWrite(filePath, opts) {
  const { macros, failed } = await loadStore(filePath, opts);
  if (failed) throw new Error('macro library unavailable (migration or read failed); try again');
  return macros;
}

/**
 * Create (no id) or update (id) a macro. Returns the saved Macro.
 * Throws on invalid input or unknown id.
 */
async function saveMacro(input, opts = {}) {
  const parsed = MacroSaveSchema.parse(input);
  const filePath = resolvePath(opts);
  return serialize(async () => {
    const macros = await loadForWrite(filePath, opts);
    const now = new Date().toISOString();
    const projects = normalizeProjects(parsed.projects);
    let saved;
    if (parsed.id) {
      const idx = macros.findIndex((m) => m.id === parsed.id);
      if (idx === -1) throw new Error(`macro not found: ${parsed.id}`);
      saved = { ...macros[idx], label: parsed.label, agentName: parsed.agentName, tag: parsed.tag, prompt: parsed.prompt, projects, updatedAt: now };
      macros[idx] = saved;
    } else {
      saved = {
        id: newId(parsed.label, new Set(macros.map((m) => m.id))),
        label: parsed.label,
        agentName: parsed.agentName,
        tag: parsed.tag,
        prompt: parsed.prompt,
        projects,
        createdAt: now,
        updatedAt: now,
      };
      macros.push(saved);
    }
    await writeStore(filePath, macros);
    return saved;
  });
}

/** Idempotent: deleting an unknown id is still `{ ok: true }`. */
async function deleteMacro(input, opts = {}) {
  const { id } = MacroDeleteSchema.parse(input);
  const filePath = resolvePath(opts);
  return serialize(async () => {
    const macros = await loadForWrite(filePath, opts);
    const next = macros.filter((m) => m.id !== id);
    if (next.length !== macros.length) await writeStore(filePath, next);
    return { ok: true };
  });
}

/**
 * Add/remove one project cwd on a macro. Returns `{ ok: true, macro }` or
 * `{ ok: false, error }`. A macro with '*' is shown everywhere and cannot be
 * narrowed here: `{ ok: false, error: 'macro is shown in every project' }`
 * (enabled=true on a '*' macro is a no-op success).
 */
async function setMacroProject(input, opts = {}) {
  const { id, cwd, enabled } = MacroSetProjectSchema.parse(input);
  const filePath = resolvePath(opts);
  const target = normalizeCwd(cwd);
  return serialize(async () => {
    const macros = await loadForWrite(filePath, opts);
    const idx = macros.findIndex((m) => m.id === id);
    if (idx === -1) return { ok: false, error: `macro not found: ${id}` };
    const macro = macros[idx];
    if (macro.projects.includes(ALL_PROJECTS)) {
      if (enabled) return { ok: true, macro };
      return { ok: false, error: 'macro is shown in every project' };
    }
    const has = macro.projects.includes(target);
    if (enabled === has) return { ok: true, macro };
    const projects = enabled ? [...macro.projects, target] : macro.projects.filter((p) => p !== target);
    if (projects.length > 200) return { ok: false, error: 'too many projects' };
    const updated = { ...macro, projects, updatedAt: new Date().toISOString() };
    macros[idx] = updated;
    await writeStore(filePath, macros);
    return { ok: true, macro: updated };
  });
}

module.exports = {
  ALL_PROJECTS,
  MacroSchema,
  MacroSaveSchema,
  MacroDeleteSchema,
  MacroSetProjectSchema,
  listMacros,
  saveMacro,
  deleteMacro,
  setMacroProject,
  defaultFilePath,
};
