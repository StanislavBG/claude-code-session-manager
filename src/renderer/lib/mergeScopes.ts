/**
 * Scope merge engine for Claude Code settings files.
 *
 * Input is a list of {scope, data} entries in LOW→HIGH precedence order
 * (user, project, local). Output is an EffectiveNode tree that mirrors the
 * merged shape with per-leaf provenance.
 *
 * Merge rules (mirror how Claude Code reads settings at session start):
 *  - All scopes carry object at this key  → recurse key-by-key
 *  - All scopes carry array at this key   → accumulate (concat items, high→low)
 *  - Otherwise (scalar / mixed types)     → first-match-wins from highest
 *                                             precedence; lower values kept as
 *                                             `shadowed[]`. If shadowed types
 *                                             differ from winner, flag
 *                                             `typeMismatch`.
 *
 * Missing scopes (data: undefined) are skipped. Consumers are responsible for
 * ordering inputs low→high.
 */

import type { Scope } from './scopes'

export interface Shadowed {
  scope: Scope
  value: unknown
}

export interface LeafNode {
  kind: 'leaf'
  value: unknown
  winner: Scope
  shadowed: Shadowed[]
  typeMismatch?: boolean
}

export interface ObjectNode {
  kind: 'object'
  children: Record<string, EffectiveNode>
}

export interface ArrayItem {
  value: unknown
  fromScope: Scope
  /** Position within the flattened accumulated array (high→low order). */
  index: number
}

export interface ArrayNode {
  kind: 'array'
  items: ArrayItem[]
}

export type EffectiveNode = LeafNode | ObjectNode | ArrayNode

export interface ScopeInput {
  scope: Scope
  data: unknown
}

/**
 * Dotted-path strings for array keys that should OVERRIDE (first-match-wins)
 * instead of accumulate. Empty today — every array key in Claude Code's
 * settings.json accumulates across scopes. If a future key breaks this rule,
 * add its path here.
 */
export const ARRAY_OVERRIDE_PATHS: string[] = []

type Kind = 'array' | 'object' | 'scalar'

function typeOf(v: unknown): Kind {
  if (Array.isArray(v)) return 'array'
  if (v !== null && typeof v === 'object') return 'object'
  return 'scalar'
}

export function mergeScopes(inputs: ScopeInput[]): EffectiveNode {
  const scoped = inputs.filter((i) => i.data !== undefined)
  if (scoped.length === 0) return { kind: 'object', children: {} }
  return mergeValues(scoped, [])
}

function mergeValues(scoped: ScopeInput[], path: string[]): EffectiveNode {
  const arrayOverride = ARRAY_OVERRIDE_PATHS.includes(path.join('.'))
  const allObjects = scoped.every((s) => typeOf(s.data) === 'object')
  const allArrays = scoped.every((s) => typeOf(s.data) === 'array')

  if (allObjects) {
    const keys = new Set<string>()
    for (const s of scoped) {
      for (const k of Object.keys(s.data as object)) keys.add(k)
    }
    const children: Record<string, EffectiveNode> = {}
    for (const k of keys) {
      const childScoped: ScopeInput[] = scoped
        .filter((s) => k in (s.data as object))
        .map((s) => ({ scope: s.scope, data: (s.data as Record<string, unknown>)[k] }))
      children[k] = mergeValues(childScoped, [...path, k])
    }
    return { kind: 'object', children }
  }

  if (allArrays && !arrayOverride) {
    // Accumulate in high→low precedence order so the winning scope's items
    // appear first in the UI.
    const items: ArrayItem[] = []
    for (const s of [...scoped].reverse()) {
      for (const v of s.data as unknown[]) {
        items.push({ value: v, fromScope: s.scope, index: items.length })
      }
    }
    return { kind: 'array', items }
  }

  // Scalar / mixed: highest-precedence scope wins.
  const reversed = [...scoped].reverse()
  const winner = reversed[0]
  const shadowed: Shadowed[] = reversed.slice(1).map((s) => ({ scope: s.scope, value: s.data }))
  const winnerKind = typeOf(winner.data)
  const typeMismatch = shadowed.some((s) => typeOf(s.value) !== winnerKind)
  return {
    kind: 'leaf',
    value: winner.data,
    winner: winner.scope,
    shadowed,
    ...(typeMismatch ? { typeMismatch: true } : {}),
  }
}

/** Navigate into an EffectiveNode by object path. Returns null if the path
 *  doesn't exist or traverses through a non-object node. */
export function getAtPath(node: EffectiveNode, path: string[]): EffectiveNode | null {
  if (path.length === 0) return node
  if (node.kind !== 'object') return null
  const [head, ...rest] = path
  const child = node.children[head]
  if (!child) return null
  return getAtPath(child, rest)
}

/** Immutably set a value at a nested object path, creating intermediate
 *  objects as needed. Arrays at intermediate positions get replaced with
 *  an object (callers should avoid writing into array indices this way). */
export function setAtPath(obj: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  const base: Record<string, unknown> =
    obj && typeof obj === 'object' && !Array.isArray(obj)
      ? { ...(obj as Record<string, unknown>) }
      : {}
  base[head] = setAtPath(base[head], rest, value)
  return base
}
