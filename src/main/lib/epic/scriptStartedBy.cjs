'use strict';

/**
 * scriptStartedBy.cjs — how a script-started Epic records who started it.
 * EpicSource.startedBy = { kind: 'script', route, caller?, fromCwd?, fromEpicId? };
 * absent for every human press. 'new-epic-ui' stays the mint authority
 * (epicMint.cjs); startedBy sits next to it. The stored shape is lenient
 * (promptSessionSchema.cjs); this is the strict entry-point validator.
 */

const { z } = require('zod');

const CallerSchema = z.object({
  pipeline: z.string().max(200).optional(),
  runId: z.string().max(200).optional(),
  step: z.string().max(200).optional(),
  attempt: z.number().int().min(0).optional(),
}).strict();

const StartedBySchema = z.object({
  kind: z.literal('script'),
  route: z.string().min(1).max(200),
  caller: CallerSchema.optional(),
  fromCwd: z.string().max(4096).optional(),
  fromEpicId: z.string().max(200).optional(),
}).strict();

/**
 * Build a StartedBySchema-valid object, omitting absent/empty keys.
 * @param {{ route: string, caller?: object, fromCwd?: string, fromEpicId?: string }} args
 */
function buildStartedBy({ route, caller, fromCwd, fromEpicId } = {}) {
  const out = { kind: 'script', route };
  if (caller && typeof caller === 'object') {
    const c = {};
    for (const [k, v] of Object.entries(caller)) {
      if (v !== undefined && v !== null && v !== '') c[k] = v;
    }
    if (Object.keys(c).length) out.caller = c;
  }
  if (typeof fromCwd === 'string' && fromCwd) out.fromCwd = fromCwd;
  if (typeof fromEpicId === 'string' && fromEpicId) out.fromEpicId = fromEpicId;
  return StartedBySchema.parse(out);
}

module.exports = { CallerSchema, StartedBySchema, buildStartedBy };
