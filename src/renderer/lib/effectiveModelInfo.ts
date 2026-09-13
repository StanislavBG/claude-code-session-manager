/**
 * effectiveModelInfo.ts — the renderer half of "what will this Epic actually
 * run as": composes the main process's persona/evidence resolver
 * (agents:resolve-model-info, src/main/lib/effectiveModelInfo.cjs) with the
 * effort-level half, which stays in the renderer because it's a pure
 * scope-chain read over settings.json already owned by
 * useEffectiveSettings.ts (that hook's `readLeafWithSource` was written for
 * exactly this — see its header — and had zero consumers before this).
 *
 * This module ships the resolver only; rendering it is a sibling PRD's job.
 */

import { useEffect, useState } from 'react'
import { useEffectiveSettingsFor, readLeafWithSource } from './useEffectiveSettings'
import type { EffectiveNode } from './mergeScopes'
import type { Scope } from './scopes'

/** "effort high (user settings.json)" / "effort — (model default)" — the one
 *  formatter for this string, shared by EffectiveRuntimeLine (New Session /
 *  Epic detail) and Home's machine-wide caption, so the two surfaces can
 *  never drift into different wording for the same provenance fact. */
export function formatEffortSegment(effortLevel: string | null, effortSource: Scope | null): string {
  if (!effortLevel || !effortSource) return 'effort — (model default)'
  return `effort ${effortLevel} (${effortSource} settings.json)`
}

export type ModelSource = 'persona' | 'persona-overlay' | 'inherit' | 'fallback'
export type ResolvedFrom = 'scheduler-run' | 'transcript' | null

/** The main-process half — persona alias + evidence-based concrete model id. */
export interface MainModelHalf {
  agentType: string
  modelAlias: string | null
  modelSource: ModelSource
  resolvedModelId: string | null
  resolvedFrom: ResolvedFrom
  effortReachable: boolean
}

/** The full resolver output: main-process evidence + renderer-side effort scope. */
export interface EffectiveModelInfo extends MainModelHalf {
  effortLevel: string | null
  effortSource: Scope | null
}

/**
 * Pure composition of the two halves — directly unit-testable with a
 * synthetic EffectiveNode (mergeScopes over literal scope data), no IPC and
 * no React runtime required.
 */
export function composeEffectiveModelInfo(mainHalf: MainModelHalf, node: EffectiveNode): EffectiveModelInfo {
  const { value: effortLevel, source: effortSource } = readLeafWithSource(node, ['effortLevel'])
  return { ...mainHalf, effortLevel, effortSource }
}

/**
 * useEffectiveModelInfo(cwd, agentType) → the full resolver output, or null
 * until both the IPC round-trip and the settings scope chain are ready.
 * Never throws: an IPC failure degrades to `null` — the same as the
 * not-yet-loaded state — so a caller falls back to whatever it rendered
 * before this hook existed rather than a fabricated "persona not found"
 * result it can't actually stand behind.
 */
export function useEffectiveModelInfo(cwd: string | null, agentType: string | null): EffectiveModelInfo | null {
  const node = useEffectiveSettingsFor(cwd)
  const [mainHalf, setMainHalf] = useState<MainModelHalf | null>(null)

  useEffect(() => {
    if (!cwd || !agentType) {
      setMainHalf(null)
      return
    }
    let cancelled = false
    setMainHalf(null)
    window.api.agents.resolveModelInfo({ cwd, agentType }).then(
      (result) => { if (!cancelled) setMainHalf(result) },
      () => { if (!cancelled) setMainHalf(null) }
    )
    return () => {
      cancelled = true
    }
  }, [cwd, agentType])

  if (!cwd || !agentType || !mainHalf) return null
  return composeEffectiveModelInfo(mainHalf, node)
}
