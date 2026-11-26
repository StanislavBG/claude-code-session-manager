'use strict';

/**
 * agentSnapshot.cjs — the immutable AgentSnapshot (Managed Agents' versioned
 * agent), stored locally and content-addressed.
 *
 * A snapshot freezes exactly the agent definition a run used:
 *   { name, bodySha256, body, model, effort, tools, mcpServers, packs, seedVersion, environment, gearBindsChat, loadout }
 * Its id is the sha256 of its canonical JSON (keys sorted at every depth), so
 * equal definitions share one id and any edit (body, model, tools, ...) mints
 * a new one. A resume can therefore re-run precisely the definition it pinned.
 *
 * Store: session-manager-operations/agents/snapshots/<id>.json, written ONCE
 * (an existing id is a no-op) via util/atomicFs.cjs, writer 'agents'
 * (opsOwnership.cjs). Reads re-hash the file: a missing, unparsable or
 * tampered (hash != id) file reads as null.
 *
 * No second persona reader: the body/model/tools come from
 * agentModelResolve.cjs's resolvePrdPersonaForSpawn (its refusal is passed
 * through unchanged), effort from agentEffortResolve.cjs's resolveEpicEffort,
 * seedVersion from agentModelResolve.cjs's readOverlayAwarePersona (the same
 * merged-persona reader resolveEpicEffort uses).
 *
 * mcpServers = the server names named by the persona's mcp__<server>__<tool>
 * tools (personaToolScope.cjs's naming rule) until personas declare servers.
 *
 * environment = { id, hash } of the persona's `environment:` profile
 * (environmentProfiles.cjs's loadEnvironment; absent = headless-default), so
 * an edit to the profile file mints a new snapshot. An unknown or invalid
 * profile is refused ({ code: 'environment_unknown'|'environment_invalid' }).
 *
 * Not wired into dispatch here (ma-agent-snapshot-pin-dispatch does that).
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { opsPath, assertOpsWrite } = require('../opsOwnership.cjs');
const atomicFs = require('../util/atomicFs.cjs');
const { loadoutState } = require('../persona-macro/personaLoadout.cjs');

const WRITER = 'agents';
const ID_RE = /^[0-9a-f]{64}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** JSON with object keys sorted at every depth; arrays keep their order. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Content address of a snapshot: sha256 of its canonical JSON. */
function snapshotId(snap) {
  return sha256(canonicalJson(snap));
}

/** Server names from mcp__<server>__<tool> entries (personaToolScope.cjs rule), sorted + unique. */
function mcpServersFromTools(tools) {
  if (!Array.isArray(tools)) return [];
  const names = new Set();
  for (const t of tools.map(String)) {
    if (!t.startsWith('mcp__')) continue;
    const server = t.slice(5).split('__')[0];
    if (server) names.add(server);
  }
  return [...names].sort();
}

/** The persona's seedVersion stamp as an integer, or null when absent/invalid. */
function seedVersionOf(fm) {
  const raw = fm && fm.seedVersion;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Build (do not write) the snapshot for `agentType` in `cwd`.
 * @param {{ cwd: string, agentType?: string|null, packs?: string[], deps?: object }} opts
 * @returns {Promise<{ id: string|null, snapshot: object|null, refusal: null|{ code: string, detail: string } }>}
 *   On a persona refusal: { id: null, snapshot: null, refusal } (passed through unchanged).
 */
async function buildAgentSnapshot({ cwd, agentType, packs, deps = {} } = {}) {
  const modelResolve = require('./agentModelResolve.cjs');
  const resolvePersona = deps.resolvePrdPersonaForSpawn || modelResolve.resolvePrdPersonaForSpawn;
  const resolveEffort = deps.resolveEpicEffort || require('./agentEffortResolve.cjs').resolveEpicEffort;
  const readPersona = deps.readOverlayAwarePersona || modelResolve.readOverlayAwarePersona;
  const name = agentType || modelResolve.DEFAULT_PRD_AGENT_TYPE;

  const resolved = await resolvePersona({ cwd, agentType: name, deps });
  if (resolved.refusal) return { id: null, snapshot: null, refusal: resolved.refusal };

  const { effort } = resolveEffort({ cwd, agentType: name, deps });
  let seedVersion = null;
  let fm = null;
  try { fm = (readPersona(name, { ...deps, cwd }) || {}).fm || null; } catch { /* stays null */ }
  seedVersion = seedVersionOf(fm);

  const loadEnvironment = deps.loadEnvironment || require('./environmentProfiles.cjs').loadEnvironment;
  const envName = fm && typeof fm.environment === 'string' && fm.environment.trim() ? fm.environment.trim() : null;
  const env = loadEnvironment({ cwd, name: envName });
  if (env.code) {
    const detail = env.code === 'environment_invalid'
      ? `environment "${env.name}" is invalid (${env.file}): ${(env.errors || []).join('; ')}`
      : `environment "${env.name}" is not declared (no project, global or built-in profile)`;
    return { id: null, snapshot: null, refusal: { code: env.code, detail } };
  }

  const body = resolved.systemPrompt || '';
  const tools = Array.isArray(resolved.tools) ? resolved.tools.map(String) : null;
  const snapshot = {
    name,
    bodySha256: sha256(body),
    body,
    model: resolved.model || null,
    effort: effort || null,
    tools,
    mcpServers: mcpServersFromTools(tools),
    packs: Array.isArray(packs) ? packs.map(String) : [],
    seedVersion,
    environment: { id: env.id, hash: env.hash },
    // Gear applies to chat turns only for snapshots stamped true; older snapshots lack the key (falsy).
    gearBindsChat: true,
    loadout: loadoutState(fm),
  };
  return { id: snapshotId(snapshot), snapshot, refusal: null };
}

function snapshotFile(cwd, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`agentSnapshot: invalid snapshot id "${id}"`);
  return opsPath(cwd, 'agents', 'snapshots', `${id}.json`);
}

/**
 * Write `snap` once under its content id. An existing id is a no-op.
 * @returns {Promise<{ id: string, written: boolean, path: string }>}
 */
async function writeAgentSnapshot(cwd, snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw new Error('agentSnapshot: snapshot object required');
  const id = snapshotId(snap);
  const file = snapshotFile(cwd, id);
  try {
    await fsp.access(file);
    return { id, written: false, path: file };
  } catch { /* absent — write it */ }
  assertOpsWrite(file, WRITER);
  await atomicFs.writeTextAtomic(file, `${canonicalJson(snap)}\n`);
  return { id, written: true, path: file };
}

/**
 * Read snapshot `id`. Missing, unparsable or tampered (re-hash != id) → null.
 * @returns {Promise<object|null>}
 */
async function readAgentSnapshot(cwd, id) {
  let file;
  try { file = snapshotFile(cwd, id); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return snapshotId(parsed) === id ? parsed : null;
}

/**
 * Sync twin of readAgentSnapshot, same rules (missing/unparsable/tampered → null).
 * For epicSpawnPlan.cjs's planEpicSpawn, which must stay synchronous (chatRunner.cjs
 * registers its cancel handle in the same tick — see agentModelResolve.cjs's
 * readOverlayAwarePersona note).
 * @returns {object|null}
 */
function readAgentSnapshotSync(cwd, id) {
  let file;
  try { file = snapshotFile(cwd, id); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return snapshotId(parsed) === id ? parsed : null;
}

module.exports = {
  buildAgentSnapshot,
  writeAgentSnapshot,
  readAgentSnapshot,
  readAgentSnapshotSync,
  snapshotId,
  canonicalJson,
  mcpServersFromTools,
};
