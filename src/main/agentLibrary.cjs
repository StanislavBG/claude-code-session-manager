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
const { splitFrontmatter } = require('./lib/prd/prdFrontmatter.cjs');
const { resolveMergedPersona, PERSONA_NAME_RE } = require('./lib/persona-macro/personaMerge.cjs');
const configMgr = require('./config.cjs');
const sessionsStore = require('./sessionsStore.cjs');

/** Parses the frontmatter `tools` field ("Read, Grep, Glob, Bash") into a list. */
function parseTools(raw) {
  if (!raw) return [];
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Sentinel `projects:` entry meaning "this agent's Action button shows in every project". */
const ALL_PROJECTS = '*';

/**
 * Frontmatter values are single-line (see lib/prd/prdFrontmatter.cjs) but an
 * Action's opening instruction is genuinely multi-line prose (the builder
 * action is `/builder\n\n<instruction>`). Encode newlines as a literal `\n`
 * two-char sequence on the way out, decode on the way in — one place, so the
 * round-trip is structural rather than something each caller remembers.
 */
function encodeLine(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n');
}

function decodeLine(s) {
  if (!s) return '';
  return String(s).replace(/\\([\\n])/g, (_m, c) => (c === 'n' ? '\n' : '\\'));
}

/**
 * Serializes a persona's frontmatter + body back to `.md` file text.
 * `tags` is a Claude-Code-agnostic extension of the frontmatter (Claude Code
 * itself never reads it) — the Epic intent tags (tagLibrary.ts's TAG_LIBRARY)
 * this persona is associated with, so Agent Library and Tag Library can each
 * assign/remove the relationship from either side. Stored the same
 * comma-list way as `tools` for one parser to cover both.
 *
 * `projects` / `action` / `actionLabel` are the same kind of extension, for
 * the Sessions workspace's per-project **Action buttons**: `projects` is the
 * list of project cwds (or the `*` sentinel = every project) whose Sessions
 * toolbar shows a one-click button for this agent, `action` is the opening
 * instruction that button sends into the new session, and `actionLabel`
 * overrides the button's caption (defaults to the persona name). Claude Code
 * ignores all three; only this app reads them.
 *
 * `seedVersion` is seedAgentPersonas.cjs's bundled-persona stamp — an
 * integer, present only on the four bundled personas. Written through
 * unchanged (not Claude-Code-visible either) so a save from the Agent
 * Library editor never erases the stamp a hand-edit should keep intact.
 */
const MANAGED_PERSONA_KEYS = new Set(['name', 'description', 'tools', 'model', 'effort', 'color', 'tags', 'projects', 'action', 'actionLabel', 'title', 'seedVersion', 'executorOnly']);

/**
 * Raw text lines of every top-level frontmatter key block in `raw` whose key
 * is NOT in `managed` (key line + its continuation lines), verbatim.
 */
function extractUnmanagedLines(raw, managed) {
  if (typeof raw !== 'string' || !raw.startsWith('---\n')) return [];
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return [];
  const out = [];
  let keep = false;
  for (const line of raw.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
    if (m) keep = !managed.has(m[1]);
    if (keep) out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function serializePersona({ name, description, tools, model, effort, color, tags, projects, action, actionLabel, title, seedVersion, executorOnly, body, preservedLines }) {
  const lines = ['---', `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  if (tools && tools.length) lines.push(`tools: ${tools.join(', ')}`);
  if (model && model !== 'inherit') lines.push(`model: ${model}`);
  if (effort && effort !== 'inherit') lines.push(`effort: ${effort}`);
  if (color) lines.push(`color: ${color}`);
  if (tags && tags.length) lines.push(`tags: ${tags.join(', ')}`);
  if (projects && projects.length) lines.push(`projects: ${projects.join(', ')}`);
  if (action) lines.push(`action: ${encodeLine(action)}`);
  if (actionLabel) lines.push(`actionLabel: ${encodeLine(actionLabel)}`);
  if (title) lines.push(`title: ${title}`);
  if (typeof seedVersion === 'number' && Number.isFinite(seedVersion)) lines.push(`seedVersion: ${seedVersion}`);
  if (executorOnly === true) lines.push('executorOnly: true');
  if (Array.isArray(preservedLines) && preservedLines.length) lines.push(...preservedLines);
  lines.push('---', '');
  return lines.join('\n') + (body || '').trim() + '\n';
}

/**
 * The cwd form every override key is compared in: repeated `/` collapsed,
 * trailing `/` stripped, root kept as `/`. Same rule as the renderer's
 * `normalizeCwd` (src/renderer/lib/knownProjectAggregate.ts — main must not
 * import renderer code) minus its `trim()`: a cwd with edge whitespace then
 * fails closed as "project not open" instead of resolving to a sibling dir.
 */
function normalizeCwd(cwd) {
  const collapsed = String(cwd).replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/, '');
}

/**
 * The open project (`{ cwd, name }` from `openProjects`) whose normalized cwd
 * equals `projectCwd`'s. Matched by cwd, never by folder name — two open
 * projects can share one (`/a/proj`, `/b/proj`). Throws
 * `project not open: <cwd>` for an unknown, empty or non-string value, so an
 * override call can never land in some other project's (or the global) file.
 */
async function findOpenProject(projectCwd, loadSessions) {
  const key = typeof projectCwd === 'string' && projectCwd !== '' ? normalizeCwd(projectCwd) : null;
  const project = key === null ? undefined : (await openProjects({ loadSessions })).find((p) => p.cwd === key);
  if (!project) throw new Error(`project not open: ${projectCwd}`);
  return project;
}

/**
 * Project OVERRIDE write: a frontmatter-only overlay at
 * `<projectCwd>/.claude/agents/<name>.md` carrying ONLY the overridden `model` /
 * `effort` keys and no body (lib/persona-macro/personaMerge.cjs inherits everything else
 * from the global persona). `projectCwd` must be an OPEN project's cwd (see
 * findOpenProject). Keys already in an existing frontmatter-only
 * overlay are preserved; an existing overlay that has a BODY is refused so a
 * full-body overlay is never silently converted. Both keys unset removes the
 * file (same as `removeOverride`) rather than leaving an empty overlay.
 *
 * Registers the open project's root via `addAllowedRoot` before touching the
 * overlay: config.cjs's validateWrite allows `<root>/.claude/` writes only under
 * a registered root, and a dormant tab (no terminal running — every tab
 * restored after a restart) has no pty-registered one. The cwd has already
 * passed validatePath, so this widens nothing a terminal spawn in that project
 * would not (same precedent as projectBrief.cjs's `allowBriefWrites`). An
 * unknown or empty `projectCwd` throws in findOpenProject first, so nothing is
 * registered for it.
 */
async function saveOverlay({ name, projectCwd, model, effort, loadSessions, validatePath, writeTextAtomic, addAllowedRoot }) {
  const project = await findOpenProject(projectCwd, loadSessions);
  // Dormant tab = no pty-registered root; see JSDoc + projectBrief.cjs allowBriefWrites.
  addAllowedRoot(validatePath(project.cwd));
  const target = validatePath(path.join(project.cwd, '.claude', 'agents', `${name}.md`));
  let preserved = [];
  try {
    const rawExisting = await fsp.readFile(target, 'utf8');
    const existing = splitFrontmatter(rawExisting);
    if (existing.body.trim() !== '') {
      throw new Error(`${name} has a full-body override in ${project.name} — edit ${target} directly; it is not converted to a frontmatter-only override`);
    }
    preserved = extractUnmanagedLines(rawExisting, new Set(['model', 'effort']));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const managedLines = [];
  for (const [k, v] of [['model', model], ['effort', effort]]) {
    if (v && v !== 'inherit') managedLines.push(`${k}: ${v}`);
  }
  if (managedLines.length === 0 && preserved.length === 0) {
    await removeOverride({ name, projectCwd: project.cwd, loadSessions, validatePath });
    return { ok: true, path: target, removed: true };
  }
  const lines = ['---', ...managedLines, ...preserved, '---', ''];
  await writeTextAtomic(target, lines.join('\n'));
  return { ok: true, path: target };
}

/**
 * Writes a global persona `.md` file — `~/.claude/agents/<name>.md`. Pass
 * `originalName` when renaming an existing persona so the old file is
 * removed once the new one is written (no-op if names match). Pass
 * `projectCwd` (an OPEN project's absolute cwd) to instead write that
 * project's frontmatter-only OVERRIDE of the persona — see saveOverlay; only
 * `model` and `effort` are read in that mode. Routing is on
 * `projectCwd !== undefined`, not truthiness: an empty/null cwd throws
 * `project not open` rather than falling through to the global write with the
 * override call's blank description/tools/body.
 */
async function savePersona({
  name,
  originalName,
  description,
  tools,
  model,
  effort,
  color,
  tags,
  projects,
  action,
  actionLabel,
  title,
  seedVersion,
  executorOnly,
  body,
  projectCwd,
  globalDir = path.join(os.homedir(), '.claude', 'agents'),
  loadSessions = sessionsStore.load,
  validatePath = configMgr.validatePath,
  writeTextAtomic = configMgr.writeTextAtomic,
  addAllowedRoot = configMgr.addAllowedRoot,
} = {}) {
  if (!PERSONA_NAME_RE.test(name || '')) {
    throw new Error('agent name must be lowercase, hyphenated (e.g. "my-agent")');
  }
  if (projectCwd !== undefined) {
    return saveOverlay({ name, projectCwd, model, effort, loadSessions, validatePath, writeTextAtomic, addAllowedRoot });
  }
  const target = validatePath(path.join(globalDir, `${name}.md`));
  // A caller that omits seedVersion/title/projects/action/actionLabel (the
  // Agent Library form has no seedVersion field) must not erase what the
  // existing file holds — carry each undefined one over. An explicit value,
  // including `projects: []`, still wins. `effort` is deliberately not
  // carried: omitted means "write no effort line".
  let resolvedSeedVersion = seedVersion;
  let resolvedTitle = title;
  let resolvedProjects = projects;
  let resolvedAction = action;
  let resolvedActionLabel = actionLabel;
  let resolvedExecutorOnly = executorOnly;
  let preservedLines = [];
  try {
    preservedLines = extractUnmanagedLines(fsSync.readFileSync(target, 'utf8'), MANAGED_PERSONA_KEYS);
  } catch { /* no existing file — nothing to preserve */ }
  if ([seedVersion, title, projects, action, actionLabel, executorOnly].some((v) => v === undefined)) {
    try {
      const { fm } = splitFrontmatter(fsSync.readFileSync(target, 'utf8'));
      if (resolvedSeedVersion === undefined) {
        const existingVersion = Number(fm.seedVersion);
        if (Number.isFinite(existingVersion)) resolvedSeedVersion = existingVersion;
      }
      if (resolvedExecutorOnly === undefined && String(fm.executorOnly).trim() === 'true') resolvedExecutorOnly = true;
      if (resolvedTitle === undefined && fm.title) resolvedTitle = fm.title;
      if (resolvedProjects === undefined && fm.projects) resolvedProjects = parseTools(fm.projects);
      if (resolvedAction === undefined && fm.action) resolvedAction = decodeLine(fm.action);
      if (resolvedActionLabel === undefined && fm.actionLabel) resolvedActionLabel = decodeLine(fm.actionLabel);
    } catch { /* no existing file (or unreadable) — nothing to carry over */ }
  }
  const text = serializePersona({ name, description, tools, model, effort, color, tags, projects: resolvedProjects, action: resolvedAction, actionLabel: resolvedActionLabel, title: resolvedTitle, seedVersion: resolvedSeedVersion, executorOnly: resolvedExecutorOnly, body, preservedLines });
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

/**
 * Deletes a global persona `.md` file. Idempotent — missing file is not an error.
 * A non-kebab-case `name` (e.g. `../../notes/x`) throws before any path is built,
 * so it can never unlink a `.md` outside `globalDir`.
 */
async function deletePersona({
  name,
  globalDir = path.join(os.homedir(), '.claude', 'agents'),
  validatePath = configMgr.validatePath,
} = {}) {
  if (!PERSONA_NAME_RE.test(name || '')) {
    throw new Error('agent name must be lowercase, hyphenated (e.g. "my-agent")');
  }
  const target = validatePath(path.join(globalDir, `${name}.md`));
  try {
    await fsp.unlink(target);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { ok: true };
}

/**
 * Drops a project's local override (`<projectCwd>/.claude/agents/<name>.md`)
 * so the global definition applies there again. `projectCwd` is resolved by
 * normalized cwd against currently-open tabs (findOpenProject — the same
 * `openProjects` source `listPersonas` reports each overrideDetails `cwd` from);
 * an unknown or empty cwd throws `project not open` and deletes nothing.
 */
async function removeOverride({
  name,
  projectCwd,
  loadSessions = sessionsStore.load,
  validatePath = configMgr.validatePath,
} = {}) {
  const project = await findOpenProject(projectCwd, loadSessions);
  const target = validatePath(path.join(project.cwd, '.claude', 'agents', `${name}.md`));
  try {
    await fsp.unlink(target);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { ok: true };
}

/**
 * Currently-open project tabs, deduped by NORMALIZED cwd (normalizeCwd), as
 * `{ cwd, name }` — `cwd` is that normalized form (the override key callers
 * match on); `name` is the last path segment, display-only and never a key
 * (two open projects can share it). `loadSessions` is injectable
 * (mirrors scheduler.cjs's notifyOriginatingTab) so tests can exercise the
 * dedup/naming logic without touching the real persisted tabs.json.
 */
async function openProjects({ loadSessions = sessionsStore.load } = {}) {
  const { tabs } = await loadSessions();
  const seen = new Set();
  const projects = [];
  for (const t of tabs ?? []) {
    if (!t || typeof t.cwd !== 'string' || !t.cwd) continue;
    const cwd = normalizeCwd(t.cwd);
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    projects.push({ cwd, name: path.basename(cwd) || cwd });
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
    // Per-project merged view: which frontmatter fields (and whether the body)
    // the overlay actually overrides — from the shared merge, not a boolean.
    const overrideDetails = [];
    for (const p of projects) {
      let overlayReal;
      try {
        overlayReal = validatePath(path.join(p.cwd, '.claude', 'agents', file));
      } catch {
        continue; // project cwd outside allowed roots — skip rather than throw
      }
      if (!fsSync.existsSync(overlayReal)) continue;
      overridingProjects.push(p.name);
      const merged = resolveMergedPersona(p.cwd, path.basename(file, '.md'), { validatePath, globalDir });
      const fields = merged ? Object.keys(merged.provenance).filter((k) => merged.provenance[k] === 'overlay') : [];
      overrideDetails.push({
        project: p.name, // display label only
        cwd: p.cwd, // the override key (removeOverride / savePersona's projectCwd)
        fields,
        // The project's value for each overridden key (the UI renders global → project).
        values: merged ? Object.fromEntries(fields.map((k) => [k, merged.fm[k]])) : {},
        bodyOverridden: merged ? merged.bodySource === 'overlay' : false,
        issue: merged ? merged.overlayIssue : null,
      });
    }

    personas.push({
      name: fm.name || fallbackName,
      description: fm.description || null,
      tools: parseTools(fm.tools),
      model: fm.model || null,
      effort: fm.effort || null,
      color: fm.color || null,
      tags: parseTools(fm.tags),
      projects: parseTools(fm.projects),
      action: decodeLine(fm.action) || null,
      actionLabel: decodeLine(fm.actionLabel) || null,
      title: fm.title || null,
      seedVersion: fm.seedVersion !== undefined && Number.isFinite(Number(fm.seedVersion)) ? Number(fm.seedVersion) : null,
      executorOnly: String(fm.executorOnly).trim() === 'true',
      path: real,
      body: body.trim(),
      overridingProjects,
      overrideDetails,
    });
  }

  return personas;
}

/**
 * Reads a persona for `epicIntake.ts`'s `agentBody` input and the PRD spawn
 * path, through the shared overlay-over-global MERGE (lib/persona-macro/personaMerge.cjs —
 * see its header for the rules). Returns `{ path, text, fm, body, fromOverlay,
 * bodySource, provenance, overlayIssue }` where `fm`/`body` are the MERGED
 * view, `provenance[key]` says which frontmatter keys came from the overlay,
 * and `text` is the body-source file's raw text (byte-identical to the
 * pre-merge result for a full-body overlay) or a re-serialized merge for a
 * frontmatter-only overlay. `listPersonas` deliberately does NOT apply this —
 * it lists the global directory for the Agent Library nav page. Returns `null`
 * when neither location has the file; frontmatter stripping and the 6000-char
 * cap are epicIntake.ts's / agentModelResolve.cjs's job, not this reader's.
 * (Sync fs inside an async signature: the merge module is shared with the
 * synchronous model resolver.)
 */
async function getPersonaBody({
  cwd,
  name,
  validatePath = configMgr.validatePath,
  ...deps
} = {}) {
  // PERSONA_NAME_RE is enforced inside resolveMergedPersona (the traversal
  // guard for "../../other-project/CLAUDE"-style names).
  return resolveMergedPersona(cwd, name, { ...deps, validatePath });
}

module.exports = {
  listPersonas,
  openProjects,
  parseTools,
  savePersona,
  deletePersona,
  removeOverride,
  serializePersona,
  getPersonaBody,
  PERSONA_NAME_RE,
  ALL_PROJECTS,
};
