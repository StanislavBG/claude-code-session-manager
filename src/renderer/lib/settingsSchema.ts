/**
 * Bundled Claude Code settings.json schema + a shared resolver instance.
 *
 * The schema lives in src/renderer/data/claude-settings-schema.json (copied
 * from schemastore Apr 2026). Refresh it by re-fetching from
 * https://www.schemastore.org/claude-code-settings.json.
 */

import rawSchema from '../data/claude-settings-schema.json'
import { buildSchemaResolver, type SchemaResolver } from './schemaLookup'

let cached: SchemaResolver | null = null

export function settingsSchema(): SchemaResolver {
  if (!cached) cached = buildSchemaResolver(rawSchema)
  return cached
}
