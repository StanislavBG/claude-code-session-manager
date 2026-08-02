'use strict';

/**
 * agentLibrary.cjs — read-only enumeration of agent personas for the
 * "Agent Library" nav page (Home face only).
 *
 * Global agent definitions live at `~/.claude/agents/*.md`. Per Claude Code's
 * own precedence rules, a project can overlay a same-named agent at
 * `<project-cwd>/.claude/agents/<name>.md`, which wins over the global
 * definition when both exist. This module reports, for every global agent,
 * which of the currently-open TABs (per sessionsStore's persisted tab list —
 * the same source of truth the renderer keeps in sync on every open/close)
 * has such an overlay.
 *
 * All filesystem paths are routed through config.cjs's validatePath so this
 * feature can't be used to read outside the home-dir boundary already
 * enforced everywhere else in the app.
 */

const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { splitFrontmatter } = require('./lib/prdFrontmatter.cjs');
const configMgr = require('./config.cjs');
const sessionsStore = require('./sessionsStore.cjs');

/** Parses the frontmatter `tools` field ("Read, Grep, Glob, Bash") into a list. */
function parseTools(raw) {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Filename-safe persona name: lowercase, hyphenated, matches the `.md` files on disk. */
const PERSONA_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Serializes a persona's frontmatter + body back to `.md` file text.
 * `tags` is a Claude-Code-agnostic extension of the frontmatter (Claude Code
 * itself never reads it) — the Epic intent tags (tagLibrary.ts's TAG_LIBRARY)
 * this persona is associated with, so Agent Library and Tag Library can each
 * assign/remove the relationship from either side. Stored the same
 * comma-list way as `tools` for one parser to cover both.
 */
function serializePersona({ name, description, tools, model, color, tags, title, body }) {
  const lines = ['---', `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  if (tools && tools.length) lines.push(`tools: ${tools.join(', ')}`);
  if (model && model !== 'inherit') lines.push(`model: ${model}`);
  if (color) lines.push(`color: ${color}`);
  if (tags && tags.length) lines.push(`tags: ${tags.join(', ')}`);
  if (title) lines.push(`title: ${title}`);
  lines.push('---', '');
  return lines.join('\n') + (body || '').trim() + '\n';
}

/**
 * Writes a global persona `.md` file — `~/.claude/agents/<name>.md`. Pass
 * `originalName` when renaming an existing persona so the old file is
 * removed once the new one is written (no-op if names match).
 */
async function savePersona({
  name,
  originalName,
  description,
  tools,
  model,
  color,
  tags,
  title,
  body,
  globalDir = path.join(os.homedir(), '.claude', 'agents'),
  validatePath = configMgr.validatePath,
  writeTextAtomic = configMgr.writeTextAtomic,
} = {}) {
  if (!PERSONA_NAME_RE.test(name || '')) {
    throw new Error('agent name must be lowercase, hyphenated (e.g. "my-agent")');
  }
  const target = validatePath(path.join(globalDir, `${name}.md`));
  const text = serializePersona({ name, description, tools, model, color, tags, title, body });
  await writeTextAtomic(target, text);
  if (originalName && originalName !== name) {
    const oldReal = validatePath(path.join(globalDir, `${originalName}.md`));
    try {
      await fsp.unlink(oldReal);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return { ok: true, path: target };
}

/** Deletes a global persona `.md` file. Idempotent — missing file is not an error. */
async function deletePersona({
  name,
  globalDir = path.join(os.homedir(), '.claude', 'agents'),
  validatePath = configMgr.validatePath,
} = {}) {
  const target = validatePath(path.join(globalDir, `${name}.md`));
  try {
    await fsp.unlink(target);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { ok: true };
}

/**
 * Drops a project's local override (`<cwd>/.claude/agents/<name>.md`) so the
 * global definition applies there again. `projectName` is resolved against
 * currently-open tabs (same source `listPersonas` uses for overridingProjects).
 */
async function removeOverride({
  name,
  projectName,
  loadSessions = sessionsStore.load,
  validatePath = configMgr.validatePath,
} = {}) {
  const projects = await openProjects({ loadSessions });
  const project = projects.find((p) => p.name === projectName);
  if (!project) throw new Error(`project not open: ${projectName}`);
  const target = validatePath(path.join(project.cwd, '.claude', 'agents', `${name}.md`));
  try {
    await fsp.unlink(target);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { ok: true };
}

/**
 * Currently-open project tabs, deduped by cwd, as `{ cwd, name }` — `name`
 * is the last path segment (matches the `projectNameFromCwd` convention used
 * by the Scheduler's ProjectTag primitive). `loadSessions` is injectable
 * (mirrors scheduler.cjs's notifyOriginatingTab) so tests can exercise the
 * dedup/naming logic without touching the real persisted tabs.json.
 */
async function openProjects({ loadSessions = sessionsStore.load } = {}) {
  const { tabs } = await loadSessions();
  const seen = new Set();
  const projects = [];
  for (const t of tabs ?? []) {
    if (!t || typeof t.cwd !== 'string' || !t.cwd || seen.has(t.cwd)) continue;
    seen.add(t.cwd);
    projects.push({ cwd: t.cwd, name: path.basename(t.cwd.replace(/\/+$/, '')) || t.cwd });
  }
  return projects;
}

/**
 * Lists every global agent persona plus which open projects overlay it.
 * Deps are injectable so tests can point `globalDir` at a fixture directory
 * and `loadSessions` at a fake tab list without touching the real
 * `~/.claude/agents` or `tabs.json`.
 */
async function listPersonas({
  globalDir = path.join(os.homedir(), '.claude', 'agents'),
  loadSessions = sessionsStore.load,
  validatePath = configMgr.validatePath,
} = {}) {
  let files;
  try {
    files = (await fsp.readdir(globalDir)).filter((f) => f.endsWith('.md'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }

  const projects = await openProjects({ loadSessions });
  const personas = [];

  for (const file of files.sort()) {
    const fallbackName = file.replace(/\.md$/, '');
    let real;
    try {
      real = validatePath(path.join(globalDir, file));
    } catch {
      continue; // out of bounds — shouldn't happen for a home-relative path
    }
    let text;
    try {
      text = await fsp.readFile(real, 'utf8');
    } catch {
      continue;
    }
    const { fm, body } = splitFrontmatter(text);

    const overridingProjects = [];
    for (const p of projects) {
      let overlayReal;
      try {
        overlayReal = validatePath(path.join(p.cwd, '.claude', 'agents', file));
      } catch {
        continue; // project cwd outside allowed roots — skip rather than throw
      }
      if (fsSync.existsSync(overlayReal)) overridingProjects.push(p.name);
    }

    personas.push({
      name: fm.name || fallbackName,
      description: fm.description || null,
      tools: parseTools(fm.tools),
      model: fm.model || null,
      color: fm.color || null,
      tags: parseTools(fm.tags),
      title: fm.title || null,
      path: real,
      body: body.trim(),
      overridingProjects,
    });
  }

  return personas;
}

module.exports = {
  listPersonas,
  openProjects,
  parseTools,
  savePersona,
  deletePersona,
  removeOverride,
  PERSONA_NAME_RE,
};
