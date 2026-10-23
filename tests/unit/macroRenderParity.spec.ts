import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { renderMacroPrompt as renderTs } from '../../src/renderer/lib/macroPrompt'
import type { MacroInput } from '../../src/preload/api'

const require = createRequire(import.meta.url)
const { renderMacroPrompt: renderCjs } = require('../../src/main/lib/persona-macro/macroLibrary.cjs')

const portfolioInputs: MacroInput[] = [
  { name: 'mode', label: 'Mode', default: 'auto', required: true, options: ['auto', 'early-check', 'review'] },
  { name: 'focus', label: 'Focus', default: 'none' },
  { name: 'instructions', label: 'Instructions', default: 'none' },
  { name: 'data', label: 'Data / links', default: 'none' },
]
const portfolioPrompt =
  'Owner inputs for this run:\n- Mode: {{mode}}\n- Focus: {{focus}}\n- Instructions: {{instructions}}\n- Data / links: {{data}}'
const a: MacroInput = { name: 'a', label: 'A' }

type Fixture = [string, string, MacroInput[] | undefined, Record<string, string>]
const fixtures: Fixture[] = [
  ['portfolio defaults', portfolioPrompt, portfolioInputs, {}],
  ['portfolio typed', portfolioPrompt, portfolioInputs, { mode: 'review', focus: 'Bilko' }],
  ['required missing', 'x={{a}}', [{ name: 'a', label: 'A', required: true }], {}],
  ['value over 500 chars', '{{a}}', [a], { a: 'x'.repeat(501) }],
  ['sanitize', '{{a}}', [a], { a: '  a\r\nb\tc\u0000d  ' }],
  ['no re-expansion', '{{a}}|{{other}}', [a, { name: 'other', label: 'O', default: 'LEAK' }], { a: '{{other}} $& $1' }],
  ['option mismatch', '{{a}}', [{ name: 'a', label: 'A', options: ['x', 'y'] }], { a: 'z' }],
  ['undeclared with inputs', '{{a}} {{b}}', [a], { a: 'v' }],
  ['undeclared with no inputs (empty)', 'keep {{x}}', [], {}],
  ['undeclared with no inputs (undefined)', 'keep {{x}}', undefined, {}],
  ['placeholder-free no inputs', 'keep $& literal', undefined, {}],
  ['rendered over 8000', 'a'.repeat(8000) + '{{a}}', [{ name: 'a', label: 'A', default: 'x' }], {}],
  ['constructor input', '{{constructor}}', [{ name: 'constructor', label: 'C', default: 'd' }], {}],
]

describe('macro render parity (renderer TS vs main CJS)', () => {
  for (const [name, prompt, inputs, values] of fixtures) {
    it(name, () => {
      expect(renderTs(prompt, inputs, values)).toEqual(renderCjs(prompt, inputs, values))
    })
  }
})
