/**
 * Generic JSON Schema walker that produces a path-queryable resolver.
 *
 * Designed for draft-07 schemas with local $refs (#/$defs/...). Handles
 * properties / items / additionalProperties / allOf merging. This is what
 * lets the Effective view show descriptions, defaults, enum hints, and
 * "ghost" rows for known-but-unset keys.
 */

interface RawSchema {
  $ref?: string
  $defs?: Record<string, RawSchema>
  definitions?: Record<string, RawSchema>
  type?: string | string[]
  description?: string
  default?: unknown
  enum?: unknown[]
  deprecated?: boolean
  examples?: unknown[]
  required?: string[]
  properties?: Record<string, RawSchema>
  items?: RawSchema | RawSchema[]
  additionalProperties?: boolean | RawSchema
  allOf?: RawSchema[]
  anyOf?: RawSchema[]
  oneOf?: RawSchema[]
  const?: unknown
}

export interface SchemaInfo {
  description?: string
  type?: string | string[]
  default?: unknown
  enum?: unknown[]
  const?: unknown
  deprecated?: boolean
  examples?: unknown[]
  /** Known child keys (only populated for object-typed nodes with `properties`). */
  knownChildren?: string[]
  /** True if this key is listed in the parent's `required[]`. */
  required?: boolean
  /** For array types: schema info describing each item. */
  itemsInfo?: SchemaInfo
  /** True when the object accepts arbitrary keys (additionalProperties). */
  open?: boolean
}

export interface SchemaResolver {
  at(path: string[]): SchemaInfo | null
  rootKeys(): string[]
  /** Return a new resolver whose root is the schema at `prefix`. */
  rootedAt(prefix: string[]): SchemaResolver
}

export function buildSchemaResolver(rawRoot: unknown): SchemaResolver {
  const root = (rawRoot ?? {}) as RawSchema
  const defs: Record<string, RawSchema> = {
    ...(root.$defs ?? {}),
    ...(root.definitions ?? {}),
  }

  const resolve = (s: RawSchema | undefined): RawSchema => {
    if (!s) return {}
    if (!s.$ref) return mergeAllOf(s)
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref)
    if (!m) return mergeAllOf(s)
    const target = defs[m[2]]
    if (!target) return mergeAllOf(s)
    // Recurse: target might itself ref or allOf. Inline rest of s over target.
    return resolve({ ...target, ...dropRef(s) })
  }

  const POISONED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
  const safeProps = (obj: Record<string, RawSchema> | undefined): Record<string, RawSchema> => {
    if (!obj) return {}
    const out: Record<string, RawSchema> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (!POISONED_KEYS.has(k)) out[k] = v
    }
    return out
  }

  const mergeAllOf = (s: RawSchema): RawSchema => {
    if (!s.allOf || s.allOf.length === 0) return s
    const merged: RawSchema = { ...s }
    delete merged.allOf
    for (const part of s.allOf) {
      const r = resolve(part)
      Object.assign(merged, {
        properties: { ...safeProps(merged.properties), ...safeProps(r.properties) },
        required: dedupe([...(merged.required ?? []), ...(r.required ?? [])]),
      })
      if (!merged.description && r.description) merged.description = r.description
      if (merged.default === undefined && r.default !== undefined) merged.default = r.default
      if (!merged.type && r.type) merged.type = r.type
    }
    return merged
  }

  const dropRef = (s: RawSchema): RawSchema => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { $ref, ...rest } = s
    return rest
  }

  /** Walk from a base schema into `path`. Returns null if path diverges. */
  const walk = (base: RawSchema, path: string[]): RawSchema | null => {
    let cur: RawSchema | null = resolve(base)
    for (const seg of path) {
      if (!cur) return null
      // Numeric segments: step into items.
      if (/^\d+$/.test(seg)) {
        const items: RawSchema | undefined = Array.isArray(cur.items)
          ? cur.items[Number(seg)]
          : cur.items
        cur = items ? resolve(items) : null
        continue
      }
      const props = cur.properties
      if (props && !POISONED_KEYS.has(seg) && seg in props) {
        cur = resolve(props[seg])
        continue
      }
      // additionalProperties: dynamic key, use its schema if defined.
      const addl = cur.additionalProperties
      if (addl && typeof addl === 'object') {
        cur = resolve(addl)
        continue
      }
      return null
    }
    return cur
  }

  const toInfo = (s: RawSchema | null, parentRequired: string[] | undefined, keyName: string | null): SchemaInfo | null => {
    if (!s) return null
    const info: SchemaInfo = {}
    if (s.description) info.description = s.description
    if (s.type) info.type = s.type
    if (s.default !== undefined) info.default = s.default
    if (s.enum) info.enum = s.enum
    if (s.const !== undefined) info.const = s.const
    if (s.deprecated) info.deprecated = true
    if (s.examples) info.examples = s.examples
    if (s.properties) info.knownChildren = Object.keys(s.properties)
    if (keyName && parentRequired?.includes(keyName)) info.required = true
    if (s.items && !Array.isArray(s.items)) {
      const items = resolve(s.items)
      const itemsInfo = toInfo(items, undefined, null)
      if (itemsInfo) info.itemsInfo = itemsInfo
    }
    if (s.additionalProperties === true || typeof s.additionalProperties === 'object') {
      info.open = true
    }
    return info
  }

  const atFrom = (base: RawSchema) => (path: string[]): SchemaInfo | null => {
    if (path.length === 0) return toInfo(resolve(base), undefined, null)
    // To populate `required`, we need the parent's required[] and the final key.
    const parentSchema = walk(base, path.slice(0, -1))
    if (!parentSchema) return null
    const key = path[path.length - 1]
    const self = walk(parentSchema, [key])
    return toInfo(self, parentSchema.required, key)
  }

  const rootKeysFrom = (base: RawSchema): string[] => {
    const r = resolve(base)
    return Object.keys(r.properties ?? {})
  }

  const makeResolver = (base: RawSchema): SchemaResolver => ({
    at: atFrom(base),
    rootKeys: () => rootKeysFrom(base),
    rootedAt: (prefix) => {
      const next = walk(base, prefix)
      return makeResolver(next ?? {})
    },
  })

  return makeResolver(root)
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs))
}
