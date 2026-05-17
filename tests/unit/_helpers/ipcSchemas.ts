/**
 * Shared scaffolding for ipc-*.spec.ts files.
 *
 * Every ipc-*.spec.ts had its own 7-line require-shim + ad-hoc type cast.
 * That boilerplate is centralized here. Specs import `{ schemas, SCHEDULE_SLUG_RE,
 * KIB, MIB, bigString, expectBoundary }` from this module.
 *
 * `KIB`/`MIB`/`bigString(n)` standardize the "construct a payload of N bytes"
 * idiom so the cap constants live in one place.
 *
 * `expectBoundary(schema, build, atMax, overMax)` is the recurring "accepts at
 * max, rejects at max+1" pair test.
 */
import { createRequire } from 'node:module'
import { expect } from 'vitest'

const requireCjs = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SchemaLike = { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => any }

const mod = requireCjs('../../../src/main/ipcSchemas.cjs') as {
  schemas: Record<string, SchemaLike>
  SCHEDULE_SLUG_RE: RegExp
  SCHEDULE_RUN_ID_RE: RegExp
  validated: (schema: { parse: (v: unknown) => unknown }, handler: (p: unknown) => unknown) => (_e: unknown, payload: unknown) => unknown
}

export const schemas = mod.schemas
export const SCHEDULE_SLUG_RE = mod.SCHEDULE_SLUG_RE
export const SCHEDULE_RUN_ID_RE = mod.SCHEDULE_RUN_ID_RE
export const validated = mod.validated

export const KIB = 1024
export const MIB = 1024 * 1024

/** Build a string of `bytes` UTF-8 bytes consisting of 'x'. */
export function bigString(bytes: number, ch = 'x'): string {
  return ch.repeat(bytes)
}

/**
 * Asserts a schema accepts a payload at the max boundary and rejects one byte
 * over. `build` receives the field value and returns the full payload.
 * Useful for path/cwd/string caps that recur across specs.
 */
export function expectBoundary(
  schema: SchemaLike,
  build: (value: string) => unknown,
  atMax: number,
  overMax: number,
) {
  expect(schema.safeParse(build(bigString(atMax))).success).toBe(true)
  expect(schema.safeParse(build(bigString(overMax))).success).toBe(false)
}
