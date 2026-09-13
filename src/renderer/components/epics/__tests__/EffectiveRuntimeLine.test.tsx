// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EffectiveRuntimeLine } from '../EffectiveRuntimeLine'
import type { EffectiveModelInfo } from '../../../lib/effectiveModelInfo'

/**
 * PRD (models readout, sibling of the effectiveModelInfo resolver): the
 * shared line New Session and Epic detail both mount to replace the bare
 * "opus" alias. Covers the 5 payload shapes the PRD's acceptance criteria
 * name explicitly — resolved, unresolved, inherit, fallback, effort-null.
 */

function info(overrides: Partial<EffectiveModelInfo>): EffectiveModelInfo {
  return {
    agentType: 'architect',
    modelAlias: 'opus',
    modelSource: 'persona',
    resolvedModelId: null,
    resolvedFrom: null,
    effortReachable: true,
    effortLevel: null,
    effortSource: null,
    ...overrides,
  }
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(payload: EffectiveModelInfo) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(createElement(EffectiveRuntimeLine, { info: payload })))
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

describe('EffectiveRuntimeLine', () => {
  it('resolved: shows alias, evidence-backed concrete model, and effort with source', () => {
    const el = mount(
      info({
        modelAlias: 'opus',
        modelSource: 'persona',
        resolvedModelId: 'claude-opus-5',
        resolvedFrom: 'scheduler-run',
        effortLevel: 'high',
        effortSource: 'user',
      })
    )
    expect(el.textContent).toContain('opus')
    expect(el.textContent).toContain('Opus 5')
    expect(el.textContent).toContain('effort high (user settings.json)')
  })

  it('unresolved: no evidence yet renders the alias plus an explicit unresolved marker, never a guessed model', () => {
    const el = mount(
      info({
        modelAlias: 'opus',
        modelSource: 'persona',
        resolvedModelId: null,
        resolvedFrom: null,
      })
    )
    expect(el.textContent).toContain('opus')
    expect(el.textContent).toContain('resolved by the CLI at launch')
    expect(el.textContent).not.toMatch(/claude-|Opus \d/)
    expect(el.textContent?.trim().length).toBeGreaterThan(0)
  })

  it('inherit: modelAlias null renders the settings-default model labeled as inherited, not an explicit choice', () => {
    const el = mount(
      info({
        modelAlias: null,
        modelSource: 'inherit',
        resolvedModelId: 'claude-sonnet-5',
        resolvedFrom: 'transcript',
      })
    )
    expect(el.textContent).toContain('inherited')
    expect(el.textContent).toContain('Sonnet 5')
    expect(el.textContent).not.toContain('opus')
  })

  it('fallback: dangling persona shows sonnet with a visible "persona not found" note', () => {
    const el = mount(
      info({
        modelAlias: null,
        modelSource: 'fallback',
        resolvedModelId: null,
        resolvedFrom: null,
      })
    )
    expect(el.textContent).toContain('sonnet')
    expect(el.textContent?.toLowerCase()).toContain('persona not found')
  })

  it('effort-null: renders "model default" rather than blank or the literal null', () => {
    const el = mount(
      info({
        modelAlias: 'opus',
        modelSource: 'persona',
        resolvedModelId: 'claude-opus-5',
        effortLevel: null,
        effortSource: null,
      })
    )
    expect(el.textContent).toContain('model default')
    expect(el.textContent).not.toContain('null')
  })
})
