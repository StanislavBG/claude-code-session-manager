// @ts-check
/**
 * servicePairLocalRoutes.cjs — POST /admin/services/pair-local (start) and
 * POST /admin/services/pair-local/confirm on the token-guarded loopback admin
 * transport, so a same-machine agent can pair a service with no window step.
 * Auth is the transport's job (401 before the handler runs).
 */
'use strict';

const { z } = require('zod');

/** @param {string} error */
function statusOf(error) {
  if (error === 'web_remote_off' || error === 'no_paired_device') return 409;
  if (error === 'not_local_pairing' || error === 'no_pending_service') return 404;
  if (error === 'sas_mismatch') return 403;
  return 400;
}

/**
 * @param {{ registerRoute: (method: string, path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) => void }} adminHttp
 * @param {{ webRemote?: any }} [opts]
 */
function registerAdminRoute(adminHttp, { webRemote } = {}) {
  const { readBody, sendJson } = require('./localAdminHttp.cjs');
  const { SERVICE_TOOL_NAMES } = require('./servicePairings.cjs');
  const wr = () => webRemote || require('../../webRemote.cjs');
  const path = require('node:path');

  const startSchema = z.object({
    name: z.string().min(1).max(80),
    homeCwd: z.string().min(1).refine((p) => path.isAbsolute(p), 'homeCwd must be an absolute path'),
    tools: z.array(z.enum(/** @type {[string, ...string[]]} */ (SERVICE_TOOL_NAMES))).min(1),
    projectRoot: z.string().min(1).optional(),
  }).strict();
  const confirmSchema = z.object({
    pairingId: z.string().min(1),
    sas: z.string().regex(/^\d{6}$/),
  }).strict();

  /**
   * @template {z.ZodTypeAny} S
   * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {S} schema
   * @returns {Promise<z.infer<S> | null>}
   */
  async function parse(req, res, schema) {
    const raw = await readBody(req);
    let json;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return null;
    }
    const r = schema.safeParse(json);
    if (!r.success) {
      const i = r.error.issues[0];
      sendJson(res, 400, { ok: false, error: `${(i.path || []).join('.') || 'body'}: ${i.message}` });
      return null;
    }
    return r.data;
  }

  adminHttp.registerRoute('POST', '/admin/services/pair-local', async (req, res) => {
    const b = await parse(req, res, startSchema);
    if (!b) return;
    const r = await wr().servicePairStartLocal({ name: b.name, homeCwd: b.homeCwd, scope: b.tools, projectRoot: b.projectRoot });
    if (!r || !r.ok) {
      const error = (r && r.error) || 'pairing failed';
      sendJson(res, statusOf(error), { ok: false, error });
      return;
    }
    const { code, pairingId, codeExpiresAt, deviceId } = r;
    sendJson(res, 200, { ok: true, code, pairingId, codeExpiresAt, deviceId });
  });

  adminHttp.registerRoute('POST', '/admin/services/pair-local/confirm', async (req, res) => {
    const b = await parse(req, res, confirmSchema);
    if (!b) return;
    const r = await wr().confirmServiceSasLocal(b.pairingId, b.sas);
    if (!r || !r.ok) {
      const error = (r && r.error) || 'confirm failed';
      sendJson(res, statusOf(error), { ok: false, error });
      return;
    }
    const { pubKey: _omit, ...service } = r.service || {};
    sendJson(res, 200, { ok: true, service });
  });
}

module.exports = { registerAdminRoute };
