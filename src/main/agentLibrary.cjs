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
const { resolveMergedPersona, PERSONA_NAME_RE } = require('./lib/personaMerge.cjs');
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
 * Frontmatter values are single-line (see lib/prdFrontmatter.cjs) but an
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
 */
function serializePersona({ name, description, tools, model, effort, color, tags, projects, action, actionLabel, title, body }) {
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
  lines.push('---', '');
  return lines.join('\n') + (body || '').trim() + '\n';
}

/**
 * Project OVERRIDE write: a frontmatter-only overlay at
 * `<cwd>/.claude/agents/<name>.md` carrying ONLY the overridden `model` /
 * `effort` keys and no body (lib/personaMerge.cjs inherits everything else
 * from the global persona). Keys already in an existing frontmatter-only
 * overlay are preserved; an existing overlay that has a BODY is refused so a
 * full-body overlay is never silently converted. Both keys unset removes the
 * file (same as `removeOverride`) rather than leaving an empty overlay.
 */
async function saveOverlay({ name, projectName, model, effort, loadSessions, validatePath, writeTextAtomic }) {
  const projects = await openProjects({ loadSessions });
  const project = projects.find((p) => p.name === projectName);
  if (!project) throw new Error(`project not open: ${projectName}`);
  const target = validatePath(path.join(project.cwd, '.claude', 'agents', `${name}.md`));
  let fm = {};
  try {
    const existing = splitFrontmatter(await fsp.readFile(target, 'utf8'));
    if (existing.body.trim() !== '') {
      throw new Error(`${name} has a full-body override in ${projectName} — edit ${target} directly; it is not converted to a frontmatter-only override`);
    }
    fm = existing.fm;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const next = { ...fm };
  for (const [k, v] of [['model', model], ['effort', effort]]) {
    if (v && v !== 'inherit') next[k] = v;
    else delete next[k];
  }
  if (Object.keys(next).length === 0) {
    await removeOverride({ name, projectName, loadSessions, validatePath });
    return { ok: true, path: target, removed: true };
  }
  const lines = ['---', ...Object.entries(next).map(([k, v]) => `${k}: ${v}`), '---', ''];
  await writeTextAtomic(target, lines.join('\n'));
  return { ok: true, path: target };
}

/**
 * Writes a global persona `.md` file — `~/.claude/agents/<name>.md`. Pass
 * `originalName` when renaming an existing persona so the old file is
 * removed once the new one is written (no-op if names match). Pass
 * `projectName` (an open project) to instead write that project's
 * frontmatter-only OVERRIDE of the persona — see saveOverlay; only `model` and
 * `effort` are read in that mode.
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
  body,
  projectName,
  globalDir = path.join(os.homedir(), '.claude', 'agents'),
  loadSessions = sessionsStore.load,
  validatePath = configMgr.validatePath,
  writeTextAtomic = configMgr.writeTextAtomic,
} = {}) {
  if (!PERSONA_NAME_RE.test(name || '')) {
    throw new Error('agent name must be lowercase, hyphenated (e.g. "my-agent")');
  }
  if (projectName) {
    return saveOverlay({ name, projectName, model, effort, loadSessions, validatePath, writeTextAtomic });
  }
  const target = validatePath(path.join(globalDir, `${name}.md`));
  const text = serializePersona({ name, description, tools, model, effort, color, tags, projects, action, actionLabel, title, body });
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
        project: p.name,
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
 * path, through the shared overlay-over-global MERGE (lib/personaMerge.cjs —
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
