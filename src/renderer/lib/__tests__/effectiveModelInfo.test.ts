/**
 * effectiveModelInfo.test.ts — the renderer half of "what will this Epic
 * actually run as": composeEffectiveModelInfo layers the effort-level scope
 * chain (useEffectiveSettings.ts's mergeScopes/readLeafWithSource — already
 * unit-tested for the merge engine itself) on top of the main-process
 * persona/evidence half. Pure-function coverage: no IPC, no DOM, no temp
 * files — a literal ScopeInput array stands in for parsed settings.json
 * content at each scope.
 *
 * Run: timeout 120 npx vitest run src/renderer/lib/__tests__/effectiveModelInfo.test.ts
 */

import { describe, test, expect } from 'vitest'
import { composeEffectiveModelInfo, formatEffortSegment, type MainModelHalf } from '../effectiveModelInfo'
import { mergeScopes, type ScopeInput } from '../mergeScopes'

function node(inputs: ScopeInput[]) {
  return mergeScopes(inputs)
}

const BASE_MAIN_HALF: MainModelHalf = {
  agentType: 'dev-lead',
  modelAlias: 'opus',
  modelSource: 'persona',
  resolvedModelId: null,
  resolvedFrom: null,
  effortReachable: false,
  personaEffort: null,
  personaEffortSource: null,
}

describe('composeEffectiveModelInfo', () => {
  test('effort set at the user scope only', () => {
    const info = composeEffectiveModelInfo(BASE_MAIN_HALF, node([
      { scope: 'user', data: { effortLevel: 'high' } },
    ]))
    expect(info.effortLevel).toBe('high')
    expect(info.effortSource).toBe('user')
  })

  test('effort set at project scope wins over user scope (precedence: local > project > user)', () => {
    const info = composeEffectiveModelInfo(BASE_MAIN_HALF, node([
      { scope: 'user', data: { effortLevel: 'low' } },
      { scope: 'project', data: { effortLevel: 'medium' } },
    ]))
    expect(info.effortLevel).toBe('medium')
    expect(info.effortSource).toBe('project')
  })

  test('effort set at local scope wins over both user and project', () => {
    const info = composeEffectiveModelInfo(BASE_MAIN_HALF, node([
      { scope: 'user', data: { effortLevel: 'low' } },
      { scope: 'project', data: { effortLevel: 'medium' } },
      { scope: 'local', data: { effortLevel: 'high' } },
    ]))
    expect(info.effortLevel).toBe('high')
    expect(info.effortSource).toBe('local')
  })

  test('effort unset in every scope reports value and source both null — never a blank masquerading as a value', () => {
    const info = composeEffectiveModelInfo(BASE_MAIN_HALF, node([
      { scope: 'user', data: { model: 'opus' } },
    ]))
    expect(info.effortLevel).toBeNull()
    expect(info.effortSource).toBeNull()
  })

  test('no scopes at all (no settings.json anywhere) reports value and source both null', () => {
    const info = composeEffectiveModelInfo(BASE_MAIN_HALF, node([]))
    expect(info.effortLevel).toBeNull()
    expect(info.effortSource).toBeNull()
  })

  test('an out-of-enum effortLevel value (e.g. "max", CLI-only, never in schemastore) is reported verbatim, not normalised away', () => {
    const info = composeEffectiveModelInfo(BASE_MAIN_HALF, node([
      { scope: 'local', data: { effortLevel: 'max' } },
    ]))
    expect(info.effortLevel).toBe('max')
    expect(info.effortSource).toBe('local')
  })

  test('passes every main-half field through unchanged', () => {
    const mainHalf: MainModelHalf = {
      agentType: 'architect',
      modelAlias: null,
      modelSource: 'inherit',
      resolvedModelId: 'claude-opus-5',
      resolvedFrom: 'scheduler-run',
      effortReachable: false,
      personaEffort: null,
      personaEffortSource: null,
    }
    const info = composeEffectiveModelInfo(mainHalf, node([]))
    expect(info).toMatchObject(mainHalf)
  })
})

describe('persona effort', () => {
  test('a persona effort beats a settings-scope effort in composeEffectiveModelInfo', () => {
    const info = composeEffectiveModelInfo(
      { ...BASE_MAIN_HALF, personaEffort: 'max', personaEffortSource: 'persona' },
      node([{ scope: 'user', data: { effortLevel: 'low' } }]),
    )
    expect(info.effortLevel).toBe('max')
    expect(info.effortSource).toBe('persona')
  })

  test('inherit persona falls back to the settings read', () => {
    const info = composeEffectiveModelInfo(
      { ...BASE_MAIN_HALF, personaEffort: null, personaEffortSource: 'inherit' },
      node([{ scope: 'user', data: { effortLevel: 'low' } }]),
    )
    expect(info.effortLevel).toBe('low')
    expect(info.effortSource).toBe('user')
  })

  test('formatEffortSegment renders persona provenance distinctly from settings provenance', () => {
    expect(formatEffortSegment('high', 'persona')).toBe('effort high (persona)')
    expect(formatEffortSegment('high', 'persona-overlay')).toBe('effort high (project persona)')
    expect(formatEffortSegment('high', 'user')).toBe('effort high (user settings.json)')
    expect(formatEffortSegment(null, null)).toBe('effort — (model default)')
  })
})
