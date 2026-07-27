import { describe, it, expect } from 'vitest'
import { resolveSettingDescription, SETTINGS_DESCRIPTION_FALLBACKS } from '../settingsDescriptionFallbacks'

describe('resolveSettingDescription', () => {
  it('prefers the schema description and marks it not-authored', () => {
    const result = resolveSettingDescription('model', 'Which model to use')
    expect(result).toEqual({ text: 'Which model to use', authored: false })
  })

  it('is unaffected by a fallback entry when a schema description exists', () => {
    const original = { ...SETTINGS_DESCRIPTION_FALLBACKS }
    try {
      SETTINGS_DESCRIPTION_FALLBACKS.model = 'authored override'
      const result = resolveSettingDescription('model', 'Which model to use')
      expect(result).toEqual({ text: 'Which model to use', authored: false })
    } finally {
      for (const k of Object.keys(SETTINGS_DESCRIPTION_FALLBACKS)) delete SETTINGS_DESCRIPTION_FALLBACKS[k]
      Object.assign(SETTINGS_DESCRIPTION_FALLBACKS, original)
    }
  })

  it('falls back to an authored entry when the schema has no description', () => {
    const original = { ...SETTINGS_DESCRIPTION_FALLBACKS }
    try {
      SETTINGS_DESCRIPTION_FALLBACKS.someUndocumentedKey = 'What this key actually does.'
      const result = resolveSettingDescription('someUndocumentedKey', undefined)
      expect(result).toEqual({ text: 'What this key actually does.', authored: true })
    } finally {
      for (const k of Object.keys(SETTINGS_DESCRIPTION_FALLBACKS)) delete SETTINGS_DESCRIPTION_FALLBACKS[k]
      Object.assign(SETTINGS_DESCRIPTION_FALLBACKS, original)
    }
  })

  it('returns null when neither a schema description nor a fallback exists', () => {
    expect(resolveSettingDescription('totallyUnknownKey', undefined)).toBeNull()
  })
})
