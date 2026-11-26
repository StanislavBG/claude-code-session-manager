// @ts-check
/**
 * The one owning schema for a persona file's FRONTMATTER (the parsed
 * `fm` object splitFrontmatter returns for ~/.claude/agents/*.md or a seed in
 * src/seed/agents/). Managed Agents' "an agent definition is validated" rule,
 * kept local: an invalid persona is refused instead of silently tolerated.
 *
 * - `.strict()` over exactly agentLibrary.cjs's MANAGED_PERSONA_KEYS
 *   (imported, never copied) — an unknown key fails, naming the key.
 * - `mcpServers` / `packs` are string lists (or a comma string): the exact
 *   MCP servers and context packs a scheduler job running as this persona
 *   loads under --strict-mcp-config.
 * - `environment` names a declared environment profile
 *   (lib/claude/environmentProfiles.cjs); absent = headless-default.
 * - `model` is required and must be concrete (not `inherit`): every persona
 *   can be a PRD `agentType`, so every persona is headless-capable, and an
 *   unpinned headless run drifts to the CLI default model.
 *
 * Distinct from agentPersonaSchema.cjs, which validates the structured IPC
 * save payload. Dispatch (agentModelResolve.cjs's resolvePrdPersonaForSpawn)
 * refuses a persona that fails it.
 */
'use strict';

const { z } = require('zod');
const { MANAGED_PERSONA_KEYS } = require('../../agentLibrary.cjs');
const { BARE_TOOL, UNBOUND_TOOL } = require('./personaLoadout.cjs');

// Parsed frontmatter values are strings; structured callers may pass
// numbers (seedVersion), booleans (executorOnly) or string lists (tools/tags).
const FmValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const ModelSchema = z
  .string({ error: 'model is required: pin a concrete model (e.g. opus, sonnet, haiku)' })
  .trim()
  .min(1, 'model is required: pin a concrete model (e.g. opus, sonnet, haiku)')
  .refine((v) => v.toLowerCase() !== 'inherit', 'model must be a concrete model, not "inherit" (personas run headless)');

/** @type {Record<string, z.ZodType>} */
const shape = {};
for (const key of MANAGED_PERSONA_KEYS) shape[key] = FmValue.optional();
shape.model = ModelSchema;
// Declared capabilities (personaToolScope.cjs): a string list, or the parsed
// frontmatter's comma string ("a, b") of non-empty names — never a number or
// boolean. Every listed name must resolve at dispatch or the job parks.
const CapabilityList = z.union([
  z.array(z.string().trim().min(1, 'entries must be non-empty names')),
  z.string().trim().min(1, 'must list at least one name (or omit the key)'),
]);
shape.mcpServers = CapabilityList.optional();
shape.packs = CapabilityList.optional();
// The declared environment profile (lib/claude/environmentProfiles.cjs) a
// headless run as this persona uses; absent = headless-default. Same name rule
// as an environment file name. Existence is checked at load, not here.
shape.environment = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'environment must be a lowercase, hyphenated profile name (e.g. headless-default)')
  .optional();
// Not a MANAGED_PERSONA_KEYS entry (the save path preserves it as an
// unmanaged line), but prdAgentType.cjs's readPersonaDefaultEstimateMinutes
// reads it at dispatch, so a dispatch-time validation must admit it.
shape.defaultEstimateMinutes = FmValue.optional();

// Loadout encodings (personaLoadout.cjs): `none` = Bare, `*` = Unbound; both
// stand alone — mixed with other tools the decision is ambiguous.
shape.tools = FmValue.optional().refine((v) => {
  const names = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((t) => String(t).trim()).filter(Boolean);
  if (names.length < 2) return true;
  return !names.some((t) => t.toLowerCase() === BARE_TOOL || t === UNBOUND_TOOL);
}, 'tools: "none" (Bare) and "*" (Unbound) must stand alone, not be mixed with other tools');

const PersonaFrontmatterSchema = z.object(shape).strict();

/**
 * @param {unknown} fm
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
function validatePersonaFrontmatter(fm) {
  const r = PersonaFrontmatterSchema.safeParse(fm);
  if (r.success) return { ok: true };
  const errors = r.error.issues.map((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return `unknown frontmatter key(s): ${issue.keys.join(', ')}`;
    }
    const where = issue.path.length ? issue.path.join('.') : '(frontmatter)';
    return `${where}: ${issue.message}`;
  });
  return { ok: false, errors };
}

module.exports = { PersonaFrontmatterSchema, validatePersonaFrontmatter };
