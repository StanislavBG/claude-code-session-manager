'use strict';

/**
 * toolRiskMarks.cjs — the one module that reads, validates, writes and
 * matches per-tool risk marks kept in the Claude config layers:
 *
 *   System  = ~/.claude/tool-risk.json
 *   Project = <projectRoot>/.claude/tool-risk.json  (main checkout, never a worktree)
 *
 * File format, version 1 (pinned):
 *   { "version": 1, "interactive"?: boolean, "marks": { "<rule>": "<mark>" } }
 *
 * A rule is an MCP tool name (`mcp__srv__tool`), a server wildcard
 * (`mcp__srv__*`), a Bash prefix (`Bash(npm publish:*)`) or an exact Bash
 * command (`Bash(git push --force)`). A call is the PreToolUse shape
 * `{ tool, input? }`; for Bash, `input.command` is the command line.
 *
 * Precedence: layer first (any matching Project rule beats every System rule),
 * then specificity inside the layer (MCP exact > server wildcard; Bash exact >
 * longer prefix > shorter prefix). A compound Bash command resolves each
 * simple command and returns a blocking result if any one blocks.
 *
 * Pure apart from readMarksLayer / writeMarksLayer. No side effects at
 * require time. readMarksLayer and resolveMark never throw.
 *
 * The Bash splitter/tokenizer copies the approach of
 * scripts/hooks/lib/guard-destructive-git-policy.cjs (src/main never
 * requires from scripts/).
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic, readJsonOrSync } = require('../util/atomicFs.cjs');

const MARKS = Object.freeze(['read', 'write', 'irreversible', 'money', 'public']);
const BLOCKING_MARKS = new Set(['irreversible', 'money', 'public']);
const MARK_SET = new Set(MARKS);

const FILE_NAME = 'tool-risk.json';
const FORMAT_VERSION = 1;
const TOP_LEVEL_KEYS = new Set(['version', 'interactive', 'marks']);

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'sudo', 'command', 'exec', 'nohup', 'time']);
// sudo flags that consume the next word as their argument.
const SUDO_ARG_FLAGS = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-R', '-T']);
const SHELLS = new Set(['bash', 'sh']);

function systemMarksPath(homeDir) {
  return path.join(homeDir, '.claude', FILE_NAME);
}

function projectMarksPath(projectRoot) {
  return path.join(projectRoot, '.claude', FILE_NAME);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── Bash parsing ────────────────────────────────────────────────────────────

/** Quote-aware split on top-level `&&`, `||`, `;`, `|`, and newlines. */
function splitTopLevel(cmd) {
  const parts = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inSingle) {
      cur += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += c;
      if (c === '"' && cmd[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Quote-aware whitespace tokenizer. Returns null on an unterminated quote. */
function tokenize(str) {
  const tokens = [];
  let cur = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inSingle) {
      if (c === "'") inSingle = false; else cur += c;
      started = true;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false; else cur += c;
      started = true;
      continue;
    }
    if (c === "'") { inSingle = true; started = true; continue; }
    if (c === '"') { inDouble = true; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);
  if (inSingle || inDouble) return null;
  return tokens;
}

/** Drop leading VAR=value words and env/sudo/command/exec/nohup/time wrappers. */
function stripPrefixes(tokens) {
  let i = 0;
  for (;;) {
    while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) i++;
    if (i >= tokens.length || !WRAPPERS.has(tokens[i])) break;
    const wrapper = tokens[i++];
    while (i < tokens.length && tokens[i].startsWith('-') && tokens[i] !== '--') {
      const flag = tokens[i++];
      if (wrapper === 'sudo' && SUDO_ARG_FLAGS.has(flag)) i++;
    }
    if (tokens[i] === '--') i++;
  }
  return tokens.slice(i);
}

/** Index of the `-c` script argument for `bash -c '<cmd>'` / `sh -lc '<cmd>'`, or -1. */
function shellScriptIndex(tokens) {
  if (!SHELLS.has(tokens[0])) return -1;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-') || t.startsWith('--')) return -1;
    if (t.slice(1).includes('c')) return i + 1 < tokens.length ? i + 1 : -1;
  }
  return -1;
}

/**
 * Split a command line into simple commands (token arrays), unwrapping one
 * level of `bash -c` / `sh -c`. A wrapper's outer form is kept too, so a rule
 * on `bash` itself still matches.
 */
function simpleCommands(command, depth = 0) {
  const out = [];
  for (const part of splitTopLevel(command)) {
    const raw = tokenize(part);
    if (!raw) continue;
    const tokens = stripPrefixes(raw);
    if (tokens.length === 0) continue;
    out.push(tokens);
    if (depth === 0) {
      const idx = shellScriptIndex(tokens);
      if (idx !== -1) out.push(...simpleCommands(tokens[idx], depth + 1));
    }
  }
  return out;
}

// ── Rules ───────────────────────────────────────────────────────────────────

/**
 * @returns {{kind:'mcp', server:string, tool:string|null}
 *   | {kind:'bash', prefix:string[], exact:boolean} | null}
 */
function parseRule(rule) {
  if (typeof rule !== 'string') return null;
  if (rule.trim() === '' || /[\r\n]/.test(rule)) return null;
  if (rule.startsWith('mcp__')) {
    const rest = rule.slice(5);
    const sep = rest.indexOf('__');
    const server = sep === -1 ? rest : rest.slice(0, sep);
    if (!server || !NAME_RE.test(server)) return null;
    if (sep === -1) return { kind: 'mcp', server, tool: null };
    const tool = rest.slice(sep + 2);
    if (tool === '*') return { kind: 'mcp', server, tool: null };
    if (!tool || !NAME_RE.test(tool)) return null;
    return { kind: 'mcp', server, tool };
  }
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return null;
  let inner = m[1];
  let exact = true;
  if (inner.endsWith(':*')) { inner = inner.slice(0, -2); exact = false; }
  const prefix = tokenize(inner);
  if (!prefix || prefix.length === 0) return null;
  return { kind: 'bash', prefix, exact };
}

function toParsed(rule) {
  if (isPlainObject(rule) && (rule.kind === 'mcp' || rule.kind === 'bash')) return rule;
  return parseRule(rule);
}

function tokensMatch(parsed, tokens) {
  if (parsed.exact && tokens.length !== parsed.prefix.length) return false;
  if (tokens.length < parsed.prefix.length) return false;
  for (let i = 0; i < parsed.prefix.length; i++) {
    if (tokens[i] !== parsed.prefix[i]) return false;
  }
  return true;
}

function mcpMatches(parsed, toolName) {
  if (typeof toolName !== 'string') return false;
  if (parsed.tool === null) return toolName.startsWith(`mcp__${parsed.server}__`);
  return toolName === `mcp__${parsed.server}__${parsed.tool}`;
}

function bashCommandOf(call) {
  if (!call || call.tool !== 'Bash' || !isPlainObject(call.input)) return null;
  return typeof call.input.command === 'string' ? call.input.command : null;
}

/** Does `rule` (string or parseRule result) match `call`? Never throws. */
function ruleMatches(rule, call) {
  try {
    const parsed = toParsed(rule);
    if (!parsed || !call) return false;
    if (parsed.kind === 'mcp') return mcpMatches(parsed, call.tool);
    const command = bashCommandOf(call);
    if (command === null) return false;
    return simpleCommands(command).some((tokens) => tokensMatch(parsed, tokens));
  } catch {
    return false;
  }
}

/** Higher = more specific. */
function specificity(parsed) {
  if (parsed.kind === 'mcp') return parsed.tool === null ? 1 : 2;
  return (parsed.exact ? 1e6 : 0) + parsed.prefix.length;
}

// ── Validation + fs ─────────────────────────────────────────────────────────

/** @returns {{ok:true} | {ok:false, error:string}} */
function validateMarksFile(obj) {
  if (!isPlainObject(obj)) return { ok: false, error: 'tool-risk file must be a JSON object' };
  for (const key of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(key)) return { ok: false, error: `unknown top-level key "${key}"` };
  }
  if (obj.version !== FORMAT_VERSION) {
    return { ok: false, error: `"version" must be ${FORMAT_VERSION} (got ${JSON.stringify(obj.version)})` };
  }
  if (obj.interactive !== undefined && typeof obj.interactive !== 'boolean') {
    return { ok: false, error: '"interactive" must be a boolean' };
  }
  if (!isPlainObject(obj.marks)) return { ok: false, error: '"marks" must be an object' };
  for (const [rule, mark] of Object.entries(obj.marks)) {
    if (!parseRule(rule)) return { ok: false, error: `marks key "${rule}" is not a valid rule (use mcp__server__tool, mcp__server__*, Bash(prefix:*) or Bash(exact))` };
    if (!MARK_SET.has(mark)) return { ok: false, error: `marks key "${rule}" has unknown mark ${JSON.stringify(mark)} (expected one of ${MARKS.join(', ')})` };
  }
  return { ok: true };
}

const UNPARSEABLE = Object.freeze({});

/** Read one layer. Never throws. */
function readMarksLayer(file) {
  try {
    if (typeof file !== 'string' || file === '') {
      return { ok: false, exists: false, error: 'no tool-risk file path given', file: file ?? null };
    }
    if (!fs.existsSync(file)) return { ok: true, exists: false, marks: {}, interactive: false, file };
    const obj = readJsonOrSync(file, UNPARSEABLE);
    if (obj === UNPARSEABLE) return { ok: false, exists: true, error: `${file}: unreadable or not valid JSON`, file };
    const v = validateMarksFile(obj);
    if (!v.ok) return { ok: false, exists: true, error: `${file}: ${v.error}`, file };
    return { ok: true, exists: true, marks: { ...obj.marks }, interactive: obj.interactive === true, file };
  } catch (e) {
    return { ok: false, exists: true, error: `${file}: ${e && e.message ? e.message : String(e)}`, file };
  }
}

/** Validate, then write atomically. @returns {Promise<{ok:true}|{ok:false,error:string}>} */
async function writeMarksLayer(file, obj) {
  const v = validateMarksFile(obj);
  if (!v.ok) return v;
  const out = { version: FORMAT_VERSION };
  if (obj.interactive !== undefined) out.interactive = obj.interactive;
  out.marks = { ...obj.marks };
  await writeJsonAtomic(file, out);
  return { ok: true };
}

// ── Resolution ──────────────────────────────────────────────────────────────

function layerEntries(layerObj) {
  if (!layerObj || layerObj.ok === false || !isPlainObject(layerObj.marks)) return [];
  const out = [];
  for (const [rule, mark] of Object.entries(layerObj.marks)) {
    const parsed = parseRule(rule);
    if (parsed && MARK_SET.has(mark)) out.push({ rule, mark, parsed });
  }
  return out;
}

/** Best match in one layer for a predicate over parsed rules. */
function bestInLayer(entries, matches) {
  let best = null;
  let bestScore = -1;
  for (const e of entries) {
    if (!matches(e.parsed)) continue;
    const s = specificity(e.parsed);
    if (s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}

function resolveUnit(layers, matches) {
  for (const { name, obj, entries } of layers) {
    const hit = bestInLayer(entries, matches);
    if (hit) return { mark: hit.mark, rule: hit.rule, layer: name, file: (obj && obj.file) || null };
  }
  return null;
}

/**
 * @returns {{mark:string, rule:string, layer:'project'|'system', file:string|null} | null}
 * Never throws.
 */
function resolveMark(call, layersIn) {
  try {
    const { system, project } = layersIn || {};
    if (!call || typeof call.tool !== 'string') return null;
    const layers = [
      { name: 'project', obj: project, entries: layerEntries(project) },
      { name: 'system', obj: system, entries: layerEntries(system) },
    ];
    if (call.tool !== 'Bash') {
      return resolveUnit(layers, (p) => p.kind === 'mcp' && mcpMatches(p, call.tool));
    }
    const command = bashCommandOf(call);
    if (command === null) return null;
    let result = null;
    for (const tokens of simpleCommands(command)) {
      const r = resolveUnit(layers, (p) => p.kind === 'bash' && tokensMatch(p, tokens));
      if (!r) continue;
      if (!result || MARKS.indexOf(r.mark) > MARKS.indexOf(result.mark)) result = r;
    }
    return result;
  } catch {
    return null;
  }
}

module.exports = {
  MARKS,
  BLOCKING_MARKS,
  systemMarksPath,
  projectMarksPath,
  parseRule,
  ruleMatches,
  readMarksLayer,
  validateMarksFile,
  writeMarksLayer,
  resolveMark,
};
