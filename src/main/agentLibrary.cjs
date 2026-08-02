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
      path: real,
      body: body.trim(),
      overridingProjects,
    });
  }

  return personas;
}

module.exports = { listPersonas, openProjects, parseTools };
