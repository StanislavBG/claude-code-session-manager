/**
 * Bundled Claude Code settings.json schema + a shared resolver instance.
 *
 * The schema lives in src/renderer/data/claude-settings-schema.json, with
 * provenance recorded in the sibling claude-settings-schema.meta.json.
 * Refresh both via `npm run sync:settings-schema`
 * (scripts/sync-settings-schema.cjs); check for drift without writing via
 * `node scripts/sync-settings-schema.cjs --check`.
 */

import rawSchema from '../data/claude-settings-schema.json'
import { buildSchemaResolver, type SchemaResolver } from './schemaLookup'

let cached: SchemaResolver | null = null

export function settingsSchema(): SchemaResolver {
  if (!cached) cached = buildSchemaResolver(rawSchema)
  return cached
}
