/**
 * agentAdminRoutes.cjs — read-only admin HTTP route over the persona library
 * (agentLibrary.cjs's listPersonas), so an outside app on this machine can
 * launch from the same roster with a pinned model instead of copying persona
 * text into its own prompts.
 *
 *   GET /admin/agents[?cwd=<abs>]
 *     → 200 { ok: true, agents } sorted by name. Each agent carries
 *       name, title, description, model, effort, tags, tools, executorOnly,
 *       agentCli, agentCliModel, seedVersion, path — never the persona body or
 *       the per-project override details.
 *       With cwd, each agent also has resolved: { modelId, modelAlias,
 *       modelSource, effort, effortSource } (effectiveModelInfo.cjs), or
 *       resolved: null when that persona's resolution throws. modelAlias is
 *       the effective alias: the persona's own, or the Settings default when
 *       the persona inherits.
 *
 * A query the schema rejects → 400 { ok: false, error: 'invalid query', details }.
 * A cwd that is not absolute or has no session-manager-operations folder →
 * 400 { ok: false, error: <reason> }.
 *
 * Writes no file and no audit row. Auth/loopback binding are the injected
 * localAdminHttp.cjs transport's job (see index.cjs).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { schemas } = require('../../ipcSchemas.cjs');
const { sendJson } = require('../feedback-remote/localAdminHttp.cjs');
const { opsPath } = require('../opsOwnership.cjs');

/** @param {unknown} cwd @returns {string | null} the reason this cwd is not a project, or null. */
function projectProblem(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return 'cwd must be an absolute path';
  let dir;
  try {
    dir = opsPath(cwd);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  try {
    if (!fs.statSync(dir).isDirectory()) return 'cwd has no session-manager-operations folder';
  } catch {
    return 'cwd has no session-manager-operations folder';
  }
  return null;
}

/** @param {any} p the listPersonas row → the outside-facing fields only. */
function publicAgent(p) {
  return {
    name: p.name,
    title: p.title ?? null,
    description: p.description ?? null,
    model: p.model ?? null,
    effort: p.effort ?? null,
    tags: Array.isArray(p.tags) ? p.tags : [],
    tools: Array.isArray(p.tools) ? p.tools : [],
    executorOnly: p.executorOnly === true,
    agentCli: p.agentCli ?? null,
    agentCliModel: p.agentCliModel ?? null,
    seedVersion: p.seedVersion ?? null,
    path: p.path ?? null,
  };
}

/**
 * @param {{ registerRoute: Function }} adminHttp
 * @param {{ listPersonas?: () => Promise<any[]>, resolveEffectiveModelInfo?: (args: { cwd: string, agentType: string }) => Promise<any> }} [deps]
 */
function registerAdminRoute(adminHttp, deps = {}) {
  // Lazy defaults: agentLibrary pulls in the sessions store + config manager.
  const listPersonas = deps.listPersonas || (() => require('../../agentLibrary.cjs').listPersonas());
  const resolveInfo = deps.resolveEffectiveModelInfo
    || ((/** @type {{ cwd: string, agentType: string }} */ args) => require('../claude/effectiveModelInfo.cjs').resolveEffectiveModelInfo(args));

  adminHttp.registerRoute('GET', '/admin/agents', async (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ query) => {
    let input;
    try {
      input = schemas.adminListAgentsQuery.parse(Object.fromEntries(query ?? []));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: 'invalid query', details: e?.issues ?? e?.message });
      return;
    }
    if (input.cwd !== undefined) {
      const problem = projectProblem(input.cwd);
      if (problem) {
        sendJson(res, 400, { ok: false, error: problem });
        return;
      }
    }

    const personas = await listPersonas();
    const agents = personas
      .map(publicAgent)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    if (input.cwd !== undefined) {
      const cwd = input.cwd;
      await Promise.all(agents.map(async (/** @type {any} */ agent) => {
        try {
          const info = await resolveInfo({ cwd, agentType: agent.name });
          agent.resolved = {
            modelId: info?.resolvedModelId ?? null,
            modelAlias: info?.modelAlias ?? null,
            modelSource: info?.modelSource ?? null,
            effort: info?.personaEffort ?? null,
            effortSource: info?.personaEffortSource ?? null,
          };
        } catch {
          agent.resolved = null;
        }
      }));
    }

    sendJson(res, 200, { ok: true, agents });
  });
}

module.exports = { registerAdminRoute };
