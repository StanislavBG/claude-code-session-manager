import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { CONTEXT_INJECTIONS } from '../contextInjections'

const require = createRequire(import.meta.url)

test('main-side DELEGATE_IMPLEMENTATION_TEXT matches the renderer injection text', () => {
  const { DELEGATE_IMPLEMENTATION_TEXT } = require('../../../main/lib/epic/epicStandingInstructions.cjs')
  expect(DELEGATE_IMPLEMENTATION_TEXT).toBe(CONTEXT_INJECTIONS['delegate-implementation'].text)
})
