/**
 * Authored fallback descriptions for settings.json keys the bundled
 * schemastore schema (`src/renderer/data/claude-settings-schema.json`)
 * doesn't describe.
 *
 * Verified against the current schema snapshot: every key surfaced by
 * `SETTINGS_GROUPS` (settingsGroups.ts) already carries a schemastore
 * `description` (cross-referenced via `settingsSchema()`'s resolver — zero
 * keys came up short at the time this file was written). This map is
 * therefore empty for now, but stays wired into `resolveSettingDescription`
 * so the moment a future schema refresh drops or omits a key's description,
 * an entry can be added here and it renders immediately — marked as
 * in-app-authored, never presented as official schema copy.
 */
export const SETTINGS_DESCRIPTION_FALLBACKS: Record<string, string> = {}

export interface DescriptionDisplay {
  text: string
  /** True when this text came from SETTINGS_DESCRIPTION_FALLBACKS rather than the schema. */
  authored: boolean
}

/**
 * Pick what description text to show for a settings key: the schemastore
 * description when present, otherwise an authored fallback if one exists,
 * otherwise nothing.
 */
export function resolveSettingDescription(
  keyName: string,
  schemaDescription: string | undefined,
): DescriptionDisplay | null {
  if (schemaDescription) return { text: schemaDescription, authored: false }
  const fallback = SETTINGS_DESCRIPTION_FALLBACKS[keyName]
  if (fallback) return { text: fallback, authored: true }
  return null
}
