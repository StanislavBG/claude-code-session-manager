import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { z } from 'zod'

const requireCjs = createRequire(import.meta.url)
const ipcSchemas = requireCjs('../../src/main/ipcSchemas.cjs') as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  validated: (schema: { parse: (v: unknown) => any }, handler: (p: any) => unknown) => (_e: unknown, payload: unknown) => unknown
}

/**
 * The validated() wrapper is the choke-point every schema-gated IPC handler
 * runs through. Every one of the ~28 schema-level spec files asserts that a
 * given schema rejects a bad payload — but none proves the schema is actually
 * wired up. This spec is the missing rung: it verifies validated() throws on
 * bad input and forwards the *parsed* payload (not the raw one) to the inner
 * handler. Without this, the "schema is the injection fence" claim is just a
 * comment.
 */
describe('validated() IPC wrapper', () => {
  it('throws ZodError when the schema rejects the payload', () => {
    const schema = z.object({ slug: z.string().min(1) })
    const handler = vi.fn()
    const wrapped = ipcSchemas.validated(schema, handler)
    expect(() => wrapped({} as unknown, { slug: '' })).toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  it('forwards the parsed payload to the inner handler on success', () => {
    const schema = z.object({ slug: z.string().min(1) })
    const handler = vi.fn(() => 'ok')
    const wrapped = ipcSchemas.validated(schema, handler)
    const result = wrapped({} as unknown, { slug: 'foo' })
    expect(result).toBe('ok')
    expect(handler).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledWith({ slug: 'foo' })
  })

  it('forwards the PARSED payload (with defaults applied), not the raw input', () => {
    // If validated() forwarded the raw payload, missing-with-default fields
    // would be undefined inside the handler. The wrapper must use the parsed
    // value so callers can rely on schema defaults.
    const schema = z.object({
      slug: z.string(),
      n: z.number().default(42),
    })
    const handler = vi.fn(() => null)
    const wrapped = ipcSchemas.validated(schema, handler)
    wrapped({} as unknown, { slug: 'x' })
    expect(handler).toHaveBeenCalledWith({ slug: 'x', n: 42 })
  })

  it('strips extra fields when schema is .strict()', () => {
    const schema = z.object({ slug: z.string() }).strict()
    const handler = vi.fn(() => null)
    const wrapped = ipcSchemas.validated(schema, handler)
    expect(() => wrapped({} as unknown, { slug: 'x', evil: true })).toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns the inner handler value (sync)', () => {
    const schema = z.object({ x: z.number() })
    const wrapped = ipcSchemas.validated(schema, ({ x }) => (x as number) * 2)
    expect(wrapped({} as unknown, { x: 5 })).toBe(10)
  })

  it('returns the inner handler promise (async)', async () => {
    const schema = z.object({ x: z.number() })
    const wrapped = ipcSchemas.validated(schema, async ({ x }) => (x as number) + 1)
    const out = wrapped({} as unknown, { x: 7 })
    expect(out).toBeInstanceOf(Promise)
    expect(await out).toBe(8)
  })

  it('rejection propagates synchronously (Electron IPC harness converts to rejected promise)', () => {
    // The wrapper does not catch; it re-throws so Electron's IPC layer sees
    // the ZodError and surfaces it to the renderer as a rejected promise.
    const schema = z.object({ x: z.number() })
    const wrapped = ipcSchemas.validated(schema, () => null)
    try {
      wrapped({} as unknown, { x: 'not a number' })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(z.ZodError)
    }
  })
})
