'use strict'

const { checkSource } = require('../check-explicit-any.cjs')

const lines = (src) => checkSource('x.ts', src).map((v) => v.line)
const tsxLines = (src) => checkSource('x.tsx', src).map((v) => v.line)

describe('check-explicit-any', () => {
  it('flags each explicit-any form', () => {
    const src = [
      'let a: any = 1',
      'const b = x as any',
      'const c = <any>x',
      'let d: any[] = []',
      'let e: Record<string, any> = {}',
      '// @ts-ignore',
      '/* @ts-nocheck */',
    ].join('\n')
    expect(lines(src)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('honours the allow marker only with a reason', () => {
    expect(lines('let a: any = 1 // lint-allow-any: vendor typing gap')).toEqual([])
    expect(lines('let a: any = 1 // lint-allow-any:')).toEqual([1])
  })

  it('ignores any inside comments and strings; allows unknown/company', () => {
    const src = [
      '// let a: any = 1',
      '/* x as any',
      '   y: any */',
      "const s = 'a: any'",
      'const t = `as any`',
      'let u: unknown = 1',
      'const anyone = 2',
    ].join('\n')
    expect(lines(src)).toEqual([])
  })

  it('flags type aliases and unions', () => {
    expect(lines('type X = any')).toEqual([1])
    expect(lines('type Y = string | any')).toEqual([1])
  })

  it('flags each any keyword once', () => {
    expect(lines('function f(...args: any[]) {}')).toEqual([1])
    expect(checkSource('x.ts', 'let m: Map<any, any>')).toHaveLength(1) // one line, deduped
    expect(lines('let m: Map<any,\n any>')).toEqual([1, 2])
  })

  it('is not fooled by apostrophes in JSX text', () => {
    const src = [
      'const a = <p>Don\'t</p>',
      'const y = z as any',
      'const b = <p>it\'s</p>',
    ].join('\n')
    expect(tsxLines(src)).toEqual([2])
  })

  it('ignores the word any in JSX text, template literals and identifiers', () => {
    const src = [
      'const a = <p>any of them, as any</p>',
      'const t = `x: any ${1}`',
      'const anyOfThem = 1',
      'const company = 2',
    ].join('\n')
    expect(tsxLines(src)).toEqual([])
  })

  it('finds directives only in real comments', () => {
    expect(lines("const s = '// @ts-ignore'")).toEqual([])
    expect(lines('const a = 1\n  // @ts-ignore\nconst b = 2')).toEqual([2])
  })
})
