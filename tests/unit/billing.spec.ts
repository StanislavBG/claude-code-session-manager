import { describe, test, expect } from 'vitest'
import { createRequire } from 'node:module'

// Use createRequire to import CJS modules from an ESM context.
const require = createRequire(import.meta.url)

// classifyUsageResponse is a pure function exported for unit testing; it does
// not touch electron, fetch, or the filesystem.
const { classifyUsageResponse } = require('../../src/main/usage.cjs') as {
  classifyUsageResponse: (status: number, bodyText: string) => { kind: string; httpStatus?: number; message?: string }
}

describe('classifyUsageResponse', () => {
  test('returns meter_rate_limited for 429 with rate_limit_error body', () => {
    const body = JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited by API tier' } })
    const result = classifyUsageResponse(429, body)
    expect(result.kind).toBe('meter_rate_limited')
    expect(result.httpStatus).toBe(429)
  })

  test('returns transient for 429 without rate_limit_error body', () => {
    const result = classifyUsageResponse(429, JSON.stringify({ error: { type: 'other_error' } }))
    expect(result.kind).toBe('transient')
    expect(result.httpStatus).toBe(429)
  })

  test('returns transient for 429 with non-JSON body', () => {
    const result = classifyUsageResponse(429, 'Too Many Requests')
    expect(result.kind).toBe('transient')
  })

  test('returns auth for 401', () => {
    expect(classifyUsageResponse(401, '').kind).toBe('auth')
  })

  test('returns auth for 403', () => {
    expect(classifyUsageResponse(403, '').kind).toBe('auth')
  })

  test('returns transient for 500', () => {
    expect(classifyUsageResponse(500, '').kind).toBe('transient')
  })

  test('returns ok for 200', () => {
    expect(classifyUsageResponse(200, '').kind).toBe('ok')
  })
})
